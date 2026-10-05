import { createClient } from '@supabase/supabase-js';
import { createSign, randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
let serviceClient;
let publicAuthClient;
const db = () => serviceClient || (serviceClient = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } }));
const authClient = () => publicAuthClient || (publicAuthClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } }));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const ok = (message = '', data = {}) => ({ success: true, message, ...data });
const clean = (v, n = 255) => String(v ?? '').trim().slice(0, n);
let cachedFcmAccessToken = '';
let cachedFcmAccessTokenExpiresAt = 0;
const base64url = (value) => Buffer.from(value).toString('base64url');
async function sendPushToUser(s, userId, title, messageBody, data = {}) {
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey || !userId) return;
  const devices = await rows(s.from('push_device_tokens').select('token').eq('user_id', userId));
  if (!devices.length) return;
  if (!cachedFcmAccessToken || Date.now() >= cachedFcmAccessTokenExpiresAt - 60_000) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600
    }))}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    const credentials = await response.json().catch(() => ({}));
    if (!response.ok || !credentials.access_token) throw new Error(`Could not authenticate with Firebase: ${credentials.error_description || credentials.error || response.status}`);
    cachedFcmAccessToken = credentials.access_token;
    cachedFcmAccessTokenExpiresAt = Date.now() + Number(credentials.expires_in || 3600) * 1000;
  }
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  await Promise.all(devices.map(async ({ token }) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cachedFcmAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token,
        notification: { title: String(title || 'TaskerPH'), body: String(messageBody || '') },
        data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value ?? '')])),
        android: { priority: 'HIGH', notification: { channel_id: 'taskerph_activity', sound: 'default' } }
      } })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = result.error?.details?.find((detail) => detail.errorCode)?.errorCode;
      if (status === 'UNREGISTERED') await s.from('push_device_tokens').delete().eq('token', token);
      throw new Error(`Firebase push failed (${response.status}): ${result.error?.message || 'Unknown response'}`);
    }
  }));
}
const publicUser = (p) => ({ id: Number(p.id), first_name: p.first_name, middle_initial: p.middle_initial || '', last_name: p.last_name, email: p.email, role: p.role, avatar_path: p.avatar_path || null, ...(p.staff_permissions?{staff_permissions:p.staff_permissions}:{}) });
const publicAvatarUrl = (s, path) => {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return s.storage.from('avatars').getPublicUrl(String(path).replace(/^\/+/, '')).data.publicUrl;
};
const getProfile = async (s, authId) => {
  const { data, error } = await s.from('user_profiles').select('*').eq('auth_user_id', authId).single();
  if (error || !data) throw fail('Your account profile could not be found.', 401);
  return data;
};
const suspensionIsActive = (profile) => Boolean(profile.is_suspended)
  && (!profile.suspended_until || new Date(profile.suspended_until).getTime() > Date.now());
const defaultStaffPermissions = (role) => ({
  can_view_users: ['superadmin','support'].includes(role),
  can_moderate_tasks: ['superadmin','admin','moderator'].includes(role),
  can_review_reports: ['superadmin','admin','moderator'].includes(role),
  can_resolve_disputes: ['superadmin','admin','moderator'].includes(role)
});
const getStaffPermissions = async (s, profile) => {
  const defaults = defaultStaffPermissions(profile.role);
  if (profile.role === 'superadmin') return defaults;
  if (!['admin','moderator','support'].includes(profile.role)) return defaults;
  const override = await rows(s.from('staff_permissions').select('can_view_users,can_moderate_tasks,can_review_reports,can_resolve_disputes').eq('user_id',profile.id).maybeSingle());
  return override ? {
    can_view_users: Boolean(override.can_view_users),
    can_moderate_tasks: Boolean(override.can_moderate_tasks),
    can_review_reports: Boolean(override.can_review_reports),
    can_resolve_disputes: Boolean(override.can_resolve_disputes)
  } : defaults;
};
const touchPresence = async (s, userId, isLogin = false) => {
  const { error } = await s.rpc('touch_account_presence', { p_user_id: userId, p_is_login: isLogin });
  if (error) console.error('Account presence update failed:', error.message);
};
const logActivity = async (s, userId, eventType, summary, referenceType = null, referenceId = null) => {
  const { error } = await s.from('account_activity').insert({ user_id: userId, event_type: eventType, summary: clean(summary, 180), reference_type: referenceType, reference_id: referenceId == null ? null : String(referenceId) });
  if (error) console.error('Account activity log failed:', error.message);
};
const recordAdminAudit = async (s, actor, event) => {
  const actorName = `${actor.first_name || ''} ${actor.last_name || ''}`.trim() || 'Administrator';
  await rows(s.from('admin_audit_events').insert({
    actor_id: Number(actor.id),
    actor_name: actorName,
    actor_email: actor.email || '',
    action: clean(event.action, 80),
    target_type: clean(event.target_type, 40) || null,
    target_id: event.target_id == null ? null : String(event.target_id),
    target_label: clean(event.target_label, 240) || null,
    reason: clean(event.reason, 1000),
    before_state: event.before_state || null,
    after_state: event.after_state || null
  }));
};
const taskNotice = async (s, userId, taskId, eventType, title, message, dedupeKey) => {
  if (!userId || !taskId) return;
  const { data, error } = await s.from('task_notifications').upsert({ user_id:userId, task_id:taskId, event_type:eventType, title:clean(title,120), body:clean(message,500), dedupe_key:dedupeKey }, { onConflict:'dedupe_key', ignoreDuplicates:true }).select('id');
  if (error) throw fail(error.message,400);
  if (data?.length) {
    try { await sendPushToUser(s, userId, title, message, { type:'task', task_id:taskId, event_type:eventType }); }
    catch (pushError) { console.error('Task push notification failed:', pushError.message); }
  }
};
const rows = async (q) => { const { data, error } = await q; if (error) throw fail(error.message, error.code === '23505' ? 409 : 400); return data; };
const userFor = async (req, s, trackActivity = false) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw fail('Please log in to continue.', 401);
  const { data, error } = await s.auth.getUser(token);
  if (error || !data.user) throw fail('Your session has ended. Please log in again.', 401);
  const profile = await getProfile(s, data.user.id);
  if (suspensionIsActive(profile)) {
    const expiry = profile.suspended_until ? ` until ${new Date(profile.suspended_until).toLocaleString('en-PH')}` : '';
    throw fail(`Your account is suspended${expiry}. Contact support if you believe this is an error.`, 403);
  }
  profile.staff_permissions = await getStaffPermissions(s,profile);
  if (trackActivity) await touchPresence(s, profile.id);
  return { auth: data.user, profile, token };
};
const isMod = (u) => Boolean(u.staff_permissions?.can_moderate_tasks);
const canModerate = (u) => Boolean(u.staff_permissions?.can_moderate_tasks);
const canViewUsers = (u) => Boolean(u.staff_permissions?.can_view_users);
const canReviewReports = (u) => Boolean(u.staff_permissions?.can_review_reports);
const canResolveDisputes = (u) => Boolean(u.staff_permissions?.can_resolve_disputes);
const loadMyBids = async (s, profile) => {
  const bids = await rows(s.from('bids').select('*').eq('bidder_id', profile.id).order('created_at', { ascending: false }));
  if (!bids.length) return [];
  const taskIds = [...new Set(bids.map((bid) => bid.task_id))];
  const [tasks, unreadMessages, reviews] = await Promise.all([
    rows(s.from('tasks').select('id,user_id,title,category,location,status,owner:user_profiles!tasks_user_id_fkey(first_name,last_name)').in('id', taskIds)),
    rows(s.from('messages').select('task_id,sender_id').in('task_id', taskIds).eq('recipient_id', profile.id).is('read_at', null)),
    rows(s.from('task_reviews').select('task_id').eq('reviewer_id', profile.id).in('task_id', taskIds))
  ]);
  const taskById = new Map(tasks.map((task) => [Number(task.id), task]));
  const reviewedTaskIds = new Set(reviews.map((review) => Number(review.task_id)));
  const unreadByTask = new Map();
  for (const message of unreadMessages) {
    const key = `${Number(message.task_id)}:${Number(message.sender_id)}`;
    unreadByTask.set(key, (unreadByTask.get(key) || 0) + 1);
  }
  return bids.map((bid) => {
    const task = taskById.get(Number(bid.task_id));
    const owner = task?.owner;
    return {
      ...bid,
      status: bid.status === 'Accepted' && task?.status === 'Open' ? 'Cancelled' : bid.status,
      id: Number(bid.id), task_id: Number(bid.task_id), bidder_id: Number(bid.bidder_id),
      amount: Number(bid.amount), owner_id: Number(task?.user_id),
      owner_name: owner ? `${owner.first_name} ${owner.last_name}`.trim() : '',
      title: task?.title, category: task?.category, location: task?.location,
      task_status: task?.status,
      has_reviewed: reviewedTaskIds.has(Number(bid.task_id)),
      unread_message_count: unreadByTask.get(`${Number(bid.task_id)}:${Number(task?.user_id)}`) || 0
    };
  });
};
const loadTaskBids = async (s, task, profile) => {
  const all = await rows(s.from('bids').select('*').eq('task_id', task.id).order('created_at', { ascending: false }));
  const allowed = Number(task.user_id) === Number(profile.id) || isMod(profile);
  const visible = all.filter((bid) => allowed || bid.status !== 'Pending' || Number(bid.bidder_id) === Number(profile.id));
  if (!visible.length) return [];
  const bidderIds = [...new Set(visible.map((bid) => bid.bidder_id))];
  const reads = Number(task.user_id) === Number(profile.id)
    ? all.filter((bid) => bid.status === 'Pending').map((bid) => ({ user_id: profile.id, notification_type: 'bid', reference_id: bid.id }))
    : [];
  const [people, unreadMessages, reviews] = await Promise.all([
    rows(s.from('user_profiles').select('id,first_name,last_name,avatar_path').in('id', bidderIds)),
    rows(s.from('messages').select('sender_id').eq('task_id', task.id).eq('recipient_id', profile.id).in('sender_id', bidderIds).is('read_at', null)),
    rows(s.from('task_reviews').select('task_id').eq('task_id',task.id).eq('reviewer_id',profile.id)),
    reads.length ? rows(s.from('notification_reads').upsert(reads, { onConflict: 'user_id,notification_type,reference_id', ignoreDuplicates: true })) : Promise.resolve([])
  ]);
  const personById = new Map(people.map((person) => [Number(person.id), person]));
  const unreadByBidder = new Map();
  for (const message of unreadMessages) unreadByBidder.set(Number(message.sender_id), (unreadByBidder.get(Number(message.sender_id)) || 0) + 1);
  return visible.map((bid) => {
    const person = personById.get(Number(bid.bidder_id));
    return {
      ...bid, status: bid.status === 'Accepted' && task.status === 'Open' ? 'Cancelled' : bid.status,
      id: Number(bid.id), task_id: Number(bid.task_id), bidder_id: Number(bid.bidder_id),
      amount: Number(bid.amount), unread_message_count: unreadByBidder.get(Number(bid.bidder_id)) || 0,
      bidder_name: person ? `${person.first_name} ${person.last_name}`.trim() : 'TaskerPH member',
      bidder_avatar_path: publicAvatarUrl(s, person?.avatar_path), has_reviewed: reviews.some((review)=>Number(review.task_id)===Number(task.id))
    };
  });
};
const shapeTasks = async (s, tasks, viewer, { mine = false } = {}) => {
  if (!tasks.length) return [];
  const taskIds = tasks.map((t) => t.id);
  if (mine) {
    const [bids, reviews] = await Promise.all([
      rows(s.from('bids').select('task_id,bidder_id,status').in('task_id', taskIds)),
      rows(s.from('task_reviews').select('task_id').eq('reviewer_id', viewer.id).in('task_id', taskIds))
    ]);
    const bidCounts = new Map();
    for (const bid of bids) bidCounts.set(Number(bid.task_id), (bidCounts.get(Number(bid.task_id)) || 0) + 1);
    const activeTaskStatuses = new Set(tasks.filter((task) => ['In Progress','Awaiting Confirmation','Under Review'].includes(task.status)).map((task) => Number(task.id)));
    const accepted = bids.filter((bid) => bid.status === 'Accepted' && activeTaskStatuses.has(Number(bid.task_id)));
    const taskerIds = [...new Set(accepted.map((bid) => Number(bid.bidder_id)))];
    const taskers = taskerIds.length ? await rows(s.from('user_profiles').select('id,first_name,last_name').in('id', taskerIds)) : [];
    const taskerById = new Map(taskers.map((person) => [Number(person.id), person]));
    const acceptedByTask = new Map(accepted.map((bid) => [Number(bid.task_id), Number(bid.bidder_id)]));
    const reviewedTaskIds = new Set(reviews.map((review) => Number(review.task_id)));
    return tasks.map((task) => ({
      ...task, id: Number(task.id), user_id: Number(task.user_id), budget: Number(task.budget),
      owner_name: `${viewer.first_name} ${viewer.last_name}`.trim(), has_bid: false,
      is_saved: false, bid_count: bidCounts.get(Number(task.id)) || 0, unread_message_count: 0,
      accepted_tasker_id: acceptedByTask.get(Number(task.id)) || null,
      accepted_tasker_name: taskerById.has(acceptedByTask.get(Number(task.id))) ? `${taskerById.get(acceptedByTask.get(Number(task.id))).first_name} ${taskerById.get(acceptedByTask.get(Number(task.id))).last_name}`.trim() : '',
      has_reviewed: reviewedTaskIds.has(Number(task.id))
    }));
  }
  const ownerIds = [...new Set(tasks.map((t) => t.user_id))];
  const [owners, bids, saves, messages, reviews] = await Promise.all([
    rows(s.from('user_profiles').select('id,first_name,last_name').in('id', ownerIds)),
    rows(s.from('bids').select('task_id,bidder_id,status').in('task_id', taskIds)),
    viewer ? rows(s.from('saved_tasks').select('task_id').eq('user_id', viewer.id).in('task_id', taskIds)) : Promise.resolve([]),
    viewer ? rows(s.from('messages').select('task_id').eq('recipient_id', viewer.id).is('read_at', null).in('task_id', taskIds)) : Promise.resolve([]),
    viewer ? rows(s.from('task_reviews').select('task_id').eq('reviewer_id', viewer.id).in('task_id', taskIds)) : Promise.resolve([])
  ]);
  const ownerById = new Map(owners.map((p) => [Number(p.id), p]));
  const bidsByTask = new Map();
  for (const bid of bids) {
    const item = bidsByTask.get(Number(bid.task_id)) || { count: 0, hasBid: false };
    item.count += 1;
    if (viewer && Number(bid.bidder_id) === Number(viewer.id) && ['Pending','Accepted'].includes(bid.status)) item.hasBid = true;
    bidsByTask.set(Number(bid.task_id), item);
  }
  const savedIds = new Set(saves.map((r) => Number(r.task_id)));
  const reviewedTaskIds = new Set(reviews.map((review) => Number(review.task_id)));
  const unreadByTask = new Map();
  for (const message of messages) unreadByTask.set(Number(message.task_id), (unreadByTask.get(Number(message.task_id)) || 0) + 1);
  return tasks.map((task) => {
    const owner = ownerById.get(Number(task.user_id));
    const bidData = bidsByTask.get(Number(task.id));
    return { ...task, id: Number(task.id), user_id: Number(task.user_id), budget: Number(task.budget), owner_name: owner ? `${owner.first_name} ${owner.last_name}`.trim() : 'TaskerPH member', has_bid: Boolean(bidData?.hasBid), is_saved: savedIds.has(Number(task.id)), bid_count: bidData?.count || 0, unread_message_count: unreadByTask.get(Number(task.id)) || 0, has_reviewed: reviewedTaskIds.has(Number(task.id)) };
  });
};
const taskDetail = async (s, id, viewer) => {
  const task = await rows(s.from('tasks').select('*').eq('id', id).maybeSingle());
  if (!task) throw fail('Task not found.', 404);
  return (await shapeTasks(s, [task], viewer))[0];
};
const jsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = ''; for await (const c of req) raw += c;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!url || !anon || !service) return res.status(500).json({ success: false, message: 'Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in Vercel.' });
  const s = db(); const ac = authClient(); const query = new URL(req.url, 'https://local').searchParams;
  const route = (query.get('path') || '').replace(/^\/+|\/+$/g, '');
  const body = await jsonBody(req);
  const action = query.get('action') || body.action || '';
  let viewer = null; let profile = null;
  try {
    if (route === 'auth') {
      if (action === 'register') {
        const email = clean(body.email, 190).toLowerCase(), password = String(body.password || ''), first = clean(body.first_name, 80), last = clean(body.last_name, 80);
        if (!first || !last || !email.includes('@') || password.length < 8) throw fail('Complete the form. Passwords must be at least 8 characters.', 422);
        const { data, error } = await ac.auth.signUp({ email, password, options: { data: { first_name: first, middle_initial: clean(body.middle_initial, 1), last_name: last } } });
        if (error) throw fail(error.message, 409);
        if (data.user) { const p = await getProfile(s, data.user.id).catch(() => null); if (p) await logActivity(s, p.id, 'user_registered', `New user registered: ${first} ${last}`, 'user', p.id); }
        if (data.user && !data.session) return res.status(200).json(ok('Account created. Check your email to confirm it, then log in.'));
        const p = data.user ? await getProfile(s, data.user.id) : null;
        return res.status(200).json(ok('Account created. You can now log in.', { user: p && publicUser(p), access_token: data.session?.access_token, refresh_token: data.session?.refresh_token }));
      }
      if (action === 'login') {
        const { data, error } = await ac.auth.signInWithPassword({ email: clean(body.email).toLowerCase(), password: String(body.password || '') });
        if (error || !data.session) throw fail('The email or password is incorrect.', 401);
        profile = await getProfile(s, data.user.id);
        if (suspensionIsActive(profile)) {
          const expiry = profile.suspended_until ? ` until ${new Date(profile.suspended_until).toLocaleString('en-PH')}` : '';
          return res.status(403).json({success:false,message:`Your account is suspended${expiry}. Submit an appeal if you believe this is an error.`,suspension_appeal_available:true,access_token:data.session.access_token,refresh_token:data.session.refresh_token});
        }
        profile.staff_permissions=await getStaffPermissions(s,profile);
        await touchPresence(s, profile.id, true);
        return res.status(200).json(ok(`Welcome back, ${profile.first_name}!`, { user: publicUser(profile), access_token: data.session.access_token, refresh_token: data.session.refresh_token }));
      }
      if (action === 'refresh') {
        const refreshToken = String(body.refresh_token || '');
        if (!refreshToken) throw fail('Your session has ended. Please log in again.', 401);
        const { data, error } = await ac.auth.refreshSession({ refresh_token: refreshToken });
        if (error || !data.session) throw fail('Your session has ended. Please log in again.', 401);
        return res.status(200).json(ok('', { access_token: data.session.access_token, refresh_token: data.session.refresh_token }));
      }
      if (action === 'session') {
        try { ({ profile } = await userFor(req, s, true)); return res.status(200).json(ok('', { user: publicUser(profile) })); }
        catch { return res.status(200).json(ok('', { user: null, expired: false })); }
      }
      if (action === 'logout') { const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,''); if(token) await s.auth.admin.signOut(token).catch(()=>{}); return res.status(200).json(ok('You have been logged out.')); }
    }
    if (route === 'suspension_appeals') {
      if (action === 'submit') {
        const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
        if (!token) throw fail('Log in to submit a suspension appeal.',401);
        const {data,error}=await ac.auth.getUser(token);
        if (error || !data.user) throw fail('Your session has ended. Please log in again.',401);
        profile=await getProfile(s,data.user.id);
        if (!suspensionIsActive(profile)) throw fail('Only suspended accounts can submit a suspension appeal.',403);
        const reason=clean(body.reason,2000);
        if (reason.length<20) throw fail('Explain why the suspension should be reviewed (at least 20 characters).',422);
        const result=await s.from('suspension_appeals').insert({
          user_id:profile.id,claimant_email:clean(profile.email,190).toLowerCase(),
          claimant_name:`${profile.first_name} ${profile.last_name}`.trim(),reason
        }).select('id').single();
        if (result.error?.code==='23505') throw fail('You already have an open appeal. Wait for it to be reviewed.',409);
        if (result.error || !result.data) throw fail(result.error?.message||'Your appeal could not be submitted.',500);
        return res.status(200).json(ok('Your suspension appeal was submitted for review.'));
      }
      ({profile}=await userFor(req,s));
      if (profile.role!=='superadmin') throw fail('Only the Superadmin can review suspension appeals.',403);
      if (action==='list') {
        const status=clean(body.status,20)||'Open';
        if (!['all','Open','Approved','Denied'].includes(status)) throw fail('Choose a valid appeal status.',422);
        let appealsQuery=s.from('suspension_appeals').select('id,user_id,claimant_email,claimant_name,reason,status,resolution_note,reviewed_by,reviewed_at,created_at,user:user_profiles!suspension_appeals_user_id_fkey(is_suspended,suspension_reason,suspended_until)');
        if (status!=='all') appealsQuery=appealsQuery.eq('status',status);
        const {data,error}=await appealsQuery.order('created_at',{ascending:false}).limit(100);
        if (error) throw fail(error.message);
        return res.status(200).json(ok('',{appeals:data||[]}));
      }
      if (action==='review') {
        const id=Number(body.appeal_id), status=clean(body.status,20), note=clean(body.note,1000);
        if (!Number.isSafeInteger(id)||id<1||!['Approved','Denied'].includes(status)||!note) throw fail('Choose a decision and enter a resolution note.',422);
        const appeal=await rows(s.from('suspension_appeals').select('*').eq('id',id).maybeSingle());
        if (!appeal) throw fail('Appeal not found.',404);
        if (appeal.status!=='Open') throw fail('This appeal has already been reviewed.',409);
        const now=new Date().toISOString();
        const reviewed=await rows(s.from('suspension_appeals').update({status,resolution_note:note,reviewed_by:profile.id,reviewed_at:now}).eq('id',id).eq('status','Open').select('id'));
        if (!reviewed.length) throw fail('This appeal was already reviewed. Refresh and try again.',409);
        if (status==='Approved'&&appeal.user_id) {
          await rows(s.from('user_profiles').update({is_suspended:false,suspension_reason:null,suspended_until:null}).eq('id',appeal.user_id));
        }
        await recordAdminAudit(s,profile,{action:`suspension_appeal_${status.toLowerCase()}`,target_type:'user',target_id:appeal.user_id,target_label:appeal.claimant_name,reason:note,before_state:{appeal_status:'Open'},after_state:{appeal_status:status,account_reactivated:status==='Approved'}});
        return res.status(200).json(ok(status==='Approved'?'Appeal approved and account reactivated.':'Appeal denied.'));
      }
      throw fail('Unknown suspension appeal action.',404);
    }
    if (route === 'get_tasks' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      try { ({ profile } = await userFor(req, s, false)); } catch {}
      let q = s.from('tasks').select('*').order('created_at', { ascending: false });
      if (query.get('mine') === '1') { if (!profile) throw fail('Please log in to continue.', 401); q = q.eq('user_id', profile.id); }
      if (['Open','In Progress','Completed','Awaiting Confirmation','Under Review','Cancelled'].includes(query.get('status'))) q = q.eq('status', query.get('status'));
      else if (query.get('mine') !== '1') q = q.not('status','in','(In Progress,Completed,Awaiting Confirmation,Under Review,Cancelled)');
      if (query.get('category')) q = q.eq('category', query.get('category'));
      if (query.get('search')) { const term = query.get('search').replace(/[,%()]/g, ' '); q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%,location.ilike.%${term}%`); }
      const tasks = await rows(q); return res.status(200).json(ok('', { tasks: await shapeTasks(s, tasks, profile, { mine: query.get('mine') === '1' }) }));
    }
    if (route === 'push_devices') {
      ({ profile } = await userFor(req, s, true));
      if (req.method !== 'POST') throw fail('Use POST to update push notification settings.', 405);
      const token = clean(body.token, 4096);
      const deviceAction = clean(body.device_action || action, 20);
      if (!token || token.length < 40) throw fail('A valid device notification token is required.', 422);
      if (deviceAction === 'register') {
        const platform = ['android','ios'].includes(body.platform) ? body.platform : 'android';
        await rows(s.from('push_device_tokens').upsert({ token, user_id:profile.id, platform, updated_at:new Date().toISOString() }, { onConflict:'token' }));
        return res.status(200).json(ok('Push notifications enabled for this device.'));
      }
      if (deviceAction === 'unregister') {
        await rows(s.from('push_device_tokens').delete().eq('token',token).eq('user_id',profile.id));
        return res.status(200).json(ok('Push notifications disabled for this device.'));
      }
      throw fail('Unknown push device action.', 422);
    }
    if (route === 'create_task') {
      ({ profile } = await userFor(req, s, true));
      if (action === 'draft_list') {
        const drafts = await rows(s.from('task_drafts').select('id,data,created_at,updated_at').eq('user_id', profile.id).order('updated_at', { ascending: false }));
        return res.status(200).json(ok('', { drafts }));
      }
      if (action === 'draft_delete') {
        const draftId = Number(body.draft_id);
        if (!Number.isSafeInteger(draftId) || draftId < 1) throw fail('Choose a valid draft.', 422);
        await rows(s.from('task_drafts').delete().eq('id', draftId).eq('user_id', profile.id));
        return res.status(200).json(ok('Draft deleted.'));
      }
      if (action === 'draft_save') {
        const draftId = Number(body.draft_id) || 0;
        const source = body.data && typeof body.data === 'object' ? body.data : {};
        const photos = Array.isArray(source.photos) ? source.photos : [];
        if (photos.length > 3 || photos.some((photo) => typeof photo !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || Buffer.from(photo.slice(photo.indexOf(',') + 1), 'base64').length > 450 * 1024)) throw fail('Draft photos must be up to 3 compressed JPG images.', 422);
        const data = {
          title: clean(source.title, 180), category: clean(source.category, 80), budget: clean(source.budget, 20),
          location: clean(source.location, 160), description: clean(source.description, 2000), schedule_date: clean(source.schedule_date, 10),
          task_mode: ['on_site', 'online', 'hybrid'].includes(source.task_mode) ? source.task_mode : 'on_site',
          budget_type: ['fixed', 'negotiable'].includes(source.budget_type) ? source.budget_type : 'fixed',
          materials_included: source.materials_included === true || source.materials_included === 'on', requirements: clean(source.requirements, 1500),
          checklist: Array.isArray(source.checklist) ? source.checklist.slice(0, 20).map((item) => clean(item, 180)).filter(Boolean) : [], photos
        };
        const draftRows = draftId
          ? await rows(s.from('task_drafts').update({ data, updated_at: new Date().toISOString() }).eq('id', draftId).eq('user_id', profile.id).select('id,data,created_at,updated_at'))
          : await rows(s.from('task_drafts').insert({ user_id: profile.id, data }).select('id,data,created_at,updated_at'));
        if (!draftRows.length) throw fail('Draft not found.', 404);
        return res.status(200).json(ok('Draft saved.', { draft: draftRows[0] }));
      }
      if (action === 'check_duplicate') {
        const title = clean(body.title, 180).toLocaleLowerCase();
        if (!title) return res.status(200).json(ok('', { duplicate: false }));
        const activeTasks = await rows(s.from('tasks').select('id,title').eq('user_id', profile.id).in('status', ['Open', 'In Progress']));
        const match = activeTasks.find((task) => clean(task.title, 180).toLocaleLowerCase() === title);
        return res.status(200).json(ok('', { duplicate: Boolean(match), task_id: match ? Number(match.id) : null }));
      }
      if (action === 'repost') {
        const sourceId = Number(body.task_id);
        if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw fail('Choose a valid task to repost.', 422);
        const source = await rows(s.from('tasks').select('*').eq('id', sourceId).eq('user_id', profile.id).maybeSingle());
        if (!source) throw fail('Task not found in your account.', 404);
        if (!['Completed','Cancelled'].includes(source.status)) throw fail('Only completed or cancelled tasks can be reposted.', 409);
        const [created] = await rows(s.from('tasks').insert({
          user_id: profile.id, title: source.title, category: source.category, budget: source.budget, location: source.location,
          description: source.description, status: 'Open', schedule_date: source.schedule_date, task_mode: source.task_mode || 'on_site',
          budget_type: source.budget_type || 'fixed', materials_included: Boolean(source.materials_included), requirements: source.requirements || '',
          checklist: Array.isArray(source.checklist) ? source.checklist : []
        }).select('id'));
        const copiedUrls = [], copiedPaths = [];
        const bucketPrefix = `${url.replace(/\/$/, '')}/storage/v1/object/public/task-photos/`;
        try {
          for (const photoUrl of (Array.isArray(source.image_urls) ? source.image_urls : [])) {
            if (!photoUrl.startsWith(bucketPrefix)) { copiedUrls.push(photoUrl); continue; }
            const oldPath = decodeURIComponent(photoUrl.slice(bucketPrefix.length).split('?')[0]);
            const { data: file, error: downloadError } = await s.storage.from('task-photos').download(oldPath);
            if (downloadError) throw fail('Could not copy a task photo while reposting.', 500);
            const newPath = `${profile.id}/${created.id}/${randomUUID()}.jpg`;
            const { error: uploadError } = await s.storage.from('task-photos').upload(newPath, Buffer.from(await file.arrayBuffer()), { contentType: 'image/jpeg', upsert: false });
            if (uploadError) throw fail('Could not copy a task photo while reposting.', 500);
            copiedPaths.push(newPath);
            copiedUrls.push(s.storage.from('task-photos').getPublicUrl(newPath).data.publicUrl);
          }
          if (copiedUrls.length) await rows(s.from('tasks').update({ image_urls: copiedUrls }).eq('id', created.id));
        } catch (error) {
          if (copiedPaths.length) await s.storage.from('task-photos').remove(copiedPaths).catch(() => {});
          await s.from('tasks').delete().eq('id', created.id).catch(() => {});
          throw error;
        }
        return res.status(200).json(ok('Task reposted as a new open listing.', { task_id: Number(created.id) }));
      }
      const item = {
        user_id: profile.id, title: clean(body.title,180), category: clean(body.category,80), budget: Number(body.budget),
        location: clean(body.location,160), description: clean(body.description,2000),
        schedule_date: body.schedule_date || null,
        task_mode: ['on_site', 'online', 'hybrid'].includes(body.task_mode) ? body.task_mode : 'on_site',
        budget_type: ['fixed', 'negotiable'].includes(body.budget_type) ? body.budget_type : 'fixed',
        materials_included: body.materials_included === true || body.materials_included === 'on', requirements: clean(body.requirements,1500),
        checklist: Array.isArray(body.checklist) ? body.checklist.slice(0,20).map((value) => clean(value,180)).filter(Boolean) : []
      };
      if (!item.title || !item.category || !item.location || !item.description || !Number.isFinite(item.budget) || item.budget < 0) throw fail('Complete every field with valid values.',422);
      if (body.schedule_date) {
        const scheduleDate = new Date(`${body.schedule_date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.schedule_date) || !Number.isFinite(scheduleDate.getTime()) || scheduleDate.toISOString().slice(0, 10) !== body.schedule_date) throw fail('Choose a valid preferred date.', 422);
      }
      if (!body.allow_duplicate) {
        const activeTasks = await rows(s.from('tasks').select('id,title').eq('user_id', profile.id).in('status', ['Open', 'In Progress']));
        if (activeTasks.some((task) => clean(task.title,180).toLocaleLowerCase() === item.title.toLocaleLowerCase())) throw fail('You already have an active task with this title. Confirm if you want to post another copy.', 409);
      }
      const photos = Array.isArray(body.photos) ? body.photos : [];
      if (photos.length > 3) throw fail('You can upload up to 3 task photos.',422);
      if (photos.some((photo) => typeof photo !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo))) throw fail('Task photos must be valid JPG images.',422);
      const [created] = await rows(s.from('tasks').insert(item).select('id'));
      const uploadedPaths = [];
      try {
        const imageUrls = [];
        for (const photo of photos) {
          const bytes = Buffer.from(photo.slice(photo.indexOf(',') + 1), 'base64');
          if (!bytes.length || bytes.length > 450 * 1024) throw fail('Each task photo must be smaller than 450 KB after compression.',422);
          const path = `${profile.id}/${created.id}/${randomUUID()}.jpg`;
          const { error } = await s.storage.from('task-photos').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
          if (error) throw fail('Could not upload a task photo. Confirm the task-photos bucket migration is applied.',500);
          uploadedPaths.push(path);
          imageUrls.push(s.storage.from('task-photos').getPublicUrl(path).data.publicUrl);
        }
        if (imageUrls.length) await rows(s.from('tasks').update({ image_urls: imageUrls }).eq('id', created.id));

        return res.status(200).json(ok('Task posted successfully.', { task_id: Number(created.id) }));
      } catch (error) {
        if (uploadedPaths.length) await s.storage.from('task-photos').remove(uploadedPaths).catch(() => {});
        await s.from('tasks').delete().eq('id', created.id);
        throw error;
      }
    }
    if (route === 'saved_tasks') {
      ({ profile } = await userFor(req, s, false));
      if (action === 'toggle') {
        const id = Number(body.task_id), saved = Boolean(body.saved), t = await rows(s.from('tasks').select('user_id').eq('id',id).maybeSingle());
        if (!t) throw fail('Task not found.',404); if (Number(t.user_id) === Number(profile.id)) throw fail('You cannot save your own task.',403);
        if (saved) await rows(s.from('saved_tasks').upsert({ user_id: profile.id, task_id: id }, { onConflict: 'user_id,task_id' })); else await rows(s.from('saved_tasks').delete().eq('user_id',profile.id).eq('task_id',id));
        return res.status(200).json(ok('',{saved,task_id:id}));
      }
      const savedRows = await rows(s.from('saved_tasks').select('task_id,saved_at').eq('user_id',profile.id).order('saved_at',{ascending:false}));
      const taskRows = savedRows.length ? await rows(s.from('tasks').select('*').in('id', savedRows.map((r) => r.task_id))) : [];
      const shaped = await shapeTasks(s, taskRows, profile);
      const savedAt = new Map(savedRows.map((r) => [Number(r.task_id), r.saved_at]));
      const cleanTasks=shaped.map((t)=>({...t,saved_at:savedAt.get(Number(t.id))})); return res.status(200).json(ok('',{tasks:cleanTasks,count:cleanTasks.length}));
    }
    if (route === 'profile_actions') {
      if (action === 'public' && req.method === 'GET') {
        const publicId = Number(query.get('id'));
        if (!Number.isSafeInteger(publicId) || publicId < 1) throw fail('Invalid tasker profile.', 400);
        const publicProfile = await rows(s.from('user_profiles').select('id,first_name,middle_initial,last_name,avatar_path,created_at').eq('id', publicId).maybeSingle());
        if (!publicProfile) throw fail('This tasker profile could not be found.', 404);
        const [listingResult, totalResult, completedResult, reviewsResult] = await Promise.all([
          s.from('tasks').select('id,user_id,title,category,budget,location,description,status,created_at,image_urls,schedule_date,task_mode,budget_type,materials_included,requirements,checklist').eq('user_id', publicId).order('created_at', { ascending: false }).limit(12),
          s.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', publicId),
          s.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', publicId).eq('status', 'Completed'),
          s.from('task_reviews').select('rating,comment,created_at,reviewer:user_profiles!task_reviews_reviewer_id_fkey(first_name,last_name)').eq('reviewee_id',publicId).order('created_at',{ascending:false}).limit(20)
        ]);
        if (listingResult.error || totalResult.error || completedResult.error || reviewsResult.error) throw fail((listingResult.error || totalResult.error || completedResult.error || reviewsResult.error).message, 500);
        const acceptedBidRows=await rows(s.from('bids').select('task_id').eq('bidder_id',publicId).eq('status','Accepted'));
        const acceptedTaskIds=[...new Set(acceptedBidRows.map((bid)=>Number(bid.task_id)))];
        const taskerCompletedRows=acceptedTaskIds.length?await rows(s.from('tasks').select('id').in('id',acceptedTaskIds).eq('status','Completed')):[];
        const ratingRows=[];
        for(let offset=0;;offset+=1000) {
          const batch=await rows(s.from('task_reviews').select('rating').eq('reviewee_id',publicId).order('id').range(offset,offset+999));
          ratingRows.push(...batch);
          if(batch.length<1000) break;
        }
        const ratingCount=ratingRows.length;
        const averageRating=ratingCount?ratingRows.reduce((sum,review)=>sum+Number(review.rating||0),0)/ratingCount:0;
        const reviews=(reviewsResult.data||[]).map((review)=>({...review,reviewer_name:review.reviewer?`${review.reviewer.first_name} ${review.reviewer.last_name}`.trim():'TaskerPH member'}));
        return res.status(200).json(ok('', { profile: { id: Number(publicProfile.id), first_name: publicProfile.first_name, middle_initial: publicProfile.middle_initial || '', last_name: publicProfile.last_name, avatar_path: publicAvatarUrl(s, publicProfile.avatar_path), created_at: publicProfile.created_at }, tasks: (listingResult.data || []).map((task) => ({ ...task, id: Number(task.id), user_id: Number(task.user_id), budget: Number(task.budget) })), reviews, total_tasks: totalResult.count || 0, completed_listings: completedResult.count || 0, completed_as_tasker: taskerCompletedRows.length, average_rating: averageRating, rating_count: ratingCount }));
      }
      ({ profile } = await userFor(req, s, action !== 'get'));
      if (action === 'get') return res.status(200).json(ok('',{user:publicUser(profile)}));
      if (action === 'update_profile') {
        const {error}=await ac.auth.signInWithPassword({email:profile.email,password:String(body.current_password||'')}); if(error) throw fail('Incorrect password. Please try again.',401);
        const patch={first_name:clean(body.first_name,80),middle_initial:clean(body.middle_initial,1),last_name:clean(body.last_name,80)}; if(!patch.first_name||!patch.last_name) throw fail('Enter your first and last name.',422);
        const [p]=await rows(s.from('user_profiles').update(patch).eq('id',profile.id).select('*'));  return res.status(200).json(ok('Profile updated successfully!',{user:publicUser(p)}));
      }
      if (action === 'update_email' || action === 'change_password') {
        const {error}=await ac.auth.signInWithPassword({email:profile.email,password:String(body.current_password||'')}); if(error) throw fail('Incorrect password. Please try again.',401);
        if (action === 'update_email' && !clean(body.email,190).includes('@')) throw fail('Enter a valid email address.',422);
        if (action === 'change_password' && (String(body.new_password||'').length<8 || body.new_password!==body.confirm_password)) throw fail('New passwords must match and be at least 8 characters.',422);
        const {data,error:authError}=await s.auth.admin.updateUserById(profile.auth_user_id,action==='update_email'?{email:clean(body.email,190).toLowerCase(),email_confirm:true}:{password:String(body.new_password||'')});
        if(authError) throw fail(authError.message,400);
        if(action==='update_email') { await rows(s.from('user_profiles').update({email:clean(body.email,190).toLowerCase()}).eq('id',profile.id));  return res.status(200).json(ok('Your email was updated.',{user:{...publicUser(profile),email:clean(body.email,190).toLowerCase()}})); }
         return res.status(200).json(ok('Your password was changed.'));
      }
      if (action === 'upload_avatar') {
        const match=String(body.avatar_data||'').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/);
        if(!match) throw fail('Upload a JPG, PNG, WEBP, or GIF image.',422);
        const bytes=Buffer.from(match[2],'base64'); if(bytes.length>3*1024*1024) throw fail('Choose an image smaller than 3 MB.',422);
        const ext={ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' }[match[1]], path=`${profile.id}/${randomUUID()}.${ext}`;
        const {error}=await s.storage.from('avatars').upload(path,bytes,{contentType:match[1],upsert:true}); if(error) throw fail('The profile photo could not be saved. Create the public avatars storage bucket in Supabase.',500);
        const {data:publicUrl}=s.storage.from('avatars').getPublicUrl(path);
        const [p]=await rows(s.from('user_profiles').update({avatar_path:publicUrl.publicUrl}).eq('id',profile.id).select('*'));

        return res.status(200).json(ok('Your profile picture was updated.',{user:publicUser(p)}));
      }
    }
    if (route === 'admin_actions') {
      ({ profile } = await userFor(req,s, action !== 'activity_dashboard'));
      if (action === 'staff_dashboard') {
        const permissions=profile.staff_permissions||defaultStaffPermissions(profile.role);
        if (!permissions.can_view_users&&!permissions.can_moderate_tasks&&!permissions.can_review_reports&&!permissions.can_resolve_disputes) {
          throw fail('Your account has no admin workspace permissions.',403);
        }
        const checks=[];
        if (permissions.can_view_users) checks.push(['users',s.from('user_profiles').select('id',{count:'exact',head:true}).neq('role','superadmin')]);
        if (permissions.can_moderate_tasks) {
          checks.push(['tasks',s.from('tasks').select('id',{count:'exact',head:true})]);
          checks.push(['open_tasks',s.from('tasks').select('id',{count:'exact',head:true}).eq('status','Open')]);
          checks.push(['under_review_tasks',s.from('tasks').select('id',{count:'exact',head:true}).eq('status','Under Review')]);
          checks.push(['recent_tasks',s.from('tasks').select('id,title,category,status,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name)').order('created_at',{ascending:false}).limit(5)]);
          checks.push(['review_queue',s.from('tasks').select('id,title,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name)').eq('status','Under Review').order('created_at',{ascending:false}).limit(20)]);
        }
        if (permissions.can_review_reports) {
          checks.push(['open_reports',s.from('task_reports').select('id',{count:'exact',head:true}).eq('status','Open')]);
          checks.push(['recent_reports',s.from('task_reports').select('id,task_id,reason,details,status,created_at,task:tasks!task_reports_task_id_fkey(title)').eq('status','Open').order('created_at',{ascending:false}).limit(5)]);
        }
        if (permissions.can_resolve_disputes) checks.push(['open_disputes',s.from('task_disputes').select('id',{count:'exact',head:true}).eq('status','Open')]);
        const results=await Promise.all(checks.map(async([key,query])=>[key,await query]));
        const dashboard={permissions,stats:{},recent_tasks:[],recent_reports:[],under_review_tasks:[]};
        for (const [key,result] of results) {
          if (result.error) throw fail(result.error.message);
          if (key==='recent_tasks') dashboard.recent_tasks=(result.data||[]).map((task)=>({...task,owner_name:task.owner?`${task.owner.first_name} ${task.owner.last_name}`.trim():'Member'}));
          else if (key==='review_queue') dashboard.under_review_tasks=(result.data||[]).map((task)=>({...task,owner_name:task.owner?`${task.owner.first_name} ${task.owner.last_name}`.trim():'Member'}));
          else if (key==='recent_reports') dashboard.recent_reports=result.data||[];
          else dashboard.stats[key]=result.count||0;
        }
        return res.status(200).json(ok('',dashboard));
      }
      if (action === 'list_disputes') {
        if (!canResolveDisputes(profile)) throw fail('You do not have permission to view disputes.',403);
        const {data,error}=await s.from('task_disputes').select('id,task_id,opened_by,details,status,resolution,created_at,resolved_at,task:tasks!task_disputes_task_id_fkey(id,title,status,user_id,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email))').order('created_at',{ascending:false}).limit(100);
        if (error) throw fail(error.message);
        return res.status(200).json(ok('',{disputes:data||[]}));
      }
      if (action === 'list_staff') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can manage staff permissions.',403);
        const staff=await rows(s.from('user_profiles').select('id,first_name,last_name,email,role').in('role',['admin','moderator','support']).order('first_name'));
        const permissions=staff.length?await rows(s.from('staff_permissions').select('user_id,can_view_users,can_moderate_tasks,can_review_reports,can_resolve_disputes').in('user_id',staff.map((entry)=>entry.id))):[];
        const byUser=new Map(permissions.map((entry)=>[Number(entry.user_id),entry]));
        return res.status(200).json(ok('',{staff:staff.map((entry)=>({...entry,permissions:byUser.get(Number(entry.id))||defaultStaffPermissions(entry.role)}))}));
      }
      if (action === 'update_staff_permissions') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can manage staff permissions.',403);
        const userId=Number(body.user_id), permissionNames=['can_view_users','can_moderate_tasks','can_review_reports','can_resolve_disputes'];
        const staff=await rows(s.from('user_profiles').select('id,role').eq('id',userId).maybeSingle());
        if (!staff||!['admin','moderator','support'].includes(staff.role)) throw fail('Choose an existing staff account.',422);
        const permissions={};
        for (const key of permissionNames) {
          if (typeof body[key]!=='boolean') throw fail('Set each staff permission explicitly.',422);
          permissions[key]=body[key];
        }
        await rows(s.from('staff_permissions').upsert({user_id:userId,...permissions,updated_by:profile.id,updated_at:new Date().toISOString()},{onConflict:'user_id'}));
        await recordAdminAudit(s,profile,{action:'staff_permissions_updated',target_type:'user',target_id:userId,target_label:`${staff.role} #${userId}`,reason:'Staff permission settings updated',after_state:permissions});
        return res.status(200).json(ok('Staff permissions updated.'));
      }
      if (action === 'admin_analytics') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can view platform analytics.',403);
        const days=Number(body.days||30);
        if (![7,30,90].includes(days)) throw fail('Choose a valid analytics period.',422);
        const [summary,categories]=await Promise.all([
          s.rpc('admin_analytics_summary',{p_days:days}),
          s.rpc('admin_analytics_categories',{p_days:days})
        ]);
        if (summary.error||categories.error) throw fail((summary.error||categories.error).message);
        return res.status(200).json(ok('',{summary:summary.data?.[0]||{},categories:categories.data||[],days}));
      }
      if (action === 'list_announcements') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can manage announcements.',403);
        const announcements=await rows(s.from('platform_announcements').select('id,title,body,audience,starts_at,expires_at,is_published,created_at,updated_at').order('created_at',{ascending:false}).limit(100));
        return res.status(200).json(ok('',{announcements}));
      }
      if (action === 'save_announcement') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can manage announcements.',403);
        const title=clean(body.title,120), text=clean(body.body,2000), audience=clean(body.audience,20)||'everyone';
        const startsAt=body.starts_at?new Date(body.starts_at):new Date();
        const expiresAt=body.expires_at?new Date(body.expires_at):null;
        const hasId=body.id!==undefined&&body.id!=='';
        const id=hasId?Number(body.id):0;
        if (!title||!text||!['everyone','members','staff'].includes(audience)||typeof body.is_published!=='boolean'||(hasId&&(!Number.isSafeInteger(id)||id<1))||!Number.isFinite(startsAt.getTime())||(expiresAt&&(!Number.isFinite(expiresAt.getTime())||expiresAt<=startsAt))) throw fail('Enter a title, message, audience, publication status, and valid date window.',422);
        const patch={title,body:text,audience,starts_at:startsAt.toISOString(),expires_at:expiresAt?.toISOString()||null,is_published:body.is_published,updated_at:new Date().toISOString()};
        const saved=id?await rows(s.from('platform_announcements').update(patch).eq('id',id).select('id')):await rows(s.from('platform_announcements').insert({...patch,created_by:profile.id}).select('id'));
        if (!saved.length) throw fail('Announcement not found or could not be saved.',404);
        await recordAdminAudit(s,profile,{action:id?'announcement_updated':'announcement_created',target_type:'announcement',target_id:saved[0].id,target_label:title,after_state:{audience,is_published:patch.is_published}});
        return res.status(200).json(ok('Announcement saved.'));
      }
      if (action === 'delete_announcement') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can manage announcements.',403);
        const id=Number(body.id);
        if (!Number.isSafeInteger(id)||id<1) throw fail('Choose a valid announcement.',422);
        const announcement=await rows(s.from('platform_announcements').select('id,title').eq('id',id).maybeSingle());
        if (!announcement) throw fail('Announcement not found.',404);
        await rows(s.from('platform_announcements').delete().eq('id',id));
        await recordAdminAudit(s,profile,{action:'announcement_deleted',target_type:'announcement',target_id:id,target_label:announcement.title});
        return res.status(200).json(ok('Announcement deleted.'));
      }
      if (action === 'admin_health') {
        if (profile.role!=='superadmin') throw fail('Only the Superadmin can view system health.',403);
        const checks=await Promise.all([
          s.from('user_profiles').select('id',{head:true,count:'exact'}),
          s.from('tasks').select('id',{head:true,count:'exact'}),
          s.from('task_reports').select('id',{head:true,count:'exact'})
        ]);
        const labels=['Accounts table','Marketplace table','Reports table'];
        const health=[
          {name:'API',status:'Operational',checked_at:new Date().toISOString()},
          {name:'Database',status:checks.some((result)=>result.error)?'Degraded':'Operational',checked_at:new Date().toISOString()},
          ...checks.map((result,index)=>({name:labels[index],status:result.error?'Unavailable':'Operational',checked_at:new Date().toISOString()}))
        ];
        if (checks.some((result)=>result.error)) console.error('Admin health check found a database query failure.');
        return res.status(200).json(ok('',{health}));
      }
      if (action === 'has_reported') {
        const taskId = Number(body.task_id);
        if (!Number.isSafeInteger(taskId) || taskId < 1) throw fail('Invalid task.', 422);
        const priorReport = await rows(s.from('task_reports').select('id').eq('task_id', taskId).eq('reporter_id', profile.id).maybeSingle());
        return res.status(200).json(ok('', { has_reported: Boolean(priorReport) }));
      }
      if (action === 'activity_dashboard') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view account activity.',403);
        const [accounts, events, reports, tasks, underReviewTasks, totalTasks, completedTasks, openTasks, openReportCount, trendResult, metricsResult] = await Promise.all([
          rows(s.from('user_profiles').select('id,first_name,middle_initial,last_name,email,role,created_at,is_suspended,suspension_reason,suspended_until').order('created_at',{ascending:false}).limit(50)),
          rows(s.from('account_activity').select('id,event_type,summary,reference_type,reference_id,created_at,user:user_profiles!account_activity_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).limit(40)),
          rows(s.from('task_reports').select('id,task_id,reporter_id,reason,details,status,created_at,resolution_note,reviewed_at,task:tasks!task_reports_task_id_fkey(id,user_id,title,description,category,status,budget,location,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)),reporter:user_profiles!task_reports_reporter_id_fkey(id,first_name,last_name,email)').order('created_at',{ascending:false}).limit(20)),
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(50)),
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)').eq('status','Under Review').order('created_at',{ascending:false}).limit(200)),
          s.from('tasks').select('id',{count:'exact',head:true}),
          s.from('tasks').select('id',{count:'exact',head:true}).eq('status','Completed'),
          s.from('tasks').select('id',{count:'exact',head:true}).eq('status','Open'),
          s.from('task_reports').select('id',{count:'exact',head:true}).eq('status','Open'),
          s.rpc('admin_dashboard_trends',{p_days:30,p_category:null}),
          s.rpc('admin_dashboard_metrics')
        ]);
        for (const result of [totalTasks,completedTasks,openTasks]) if (result.error) throw fail(result.error.message);
        if (openReportCount.error || trendResult.error || metricsResult.error) throw fail((openReportCount.error || trendResult.error || metricsResult.error).message);
        const ids = accounts.map((account) => account.id);
        const presence = ids.length ? await rows(s.from('account_presence').select('user_id,last_login_at,last_seen_at').in('user_id',ids)) : [];
        const presenceByUser = new Map(presence.map((item) => [Number(item.user_id), item]));
        const users = accounts.map((account) => ({
          id: Number(account.id), first_name: account.first_name, middle_initial: account.middle_initial || '',
          last_name: account.last_name, email: account.email, role: account.role, created_at: account.created_at,
          is_suspended: suspensionIsActive(account), suspension_reason: account.suspension_reason || '',
          suspended_until: account.suspended_until || null,
          ...(presenceByUser.get(Number(account.id)) || { last_login_at: null, last_seen_at: null })
        }));
        const taskItems = tasks.map((task) => ({ ...task, id:Number(task.id), user_id:Number(task.user_id), budget:Number(task.budget)||0, owner_name:task.owner ? `${task.owner.first_name} ${task.owner.last_name}`.trim() : 'TaskerPH member' }));
        const reviewTaskItems = underReviewTasks.map((task) => ({ ...task, id:Number(task.id), user_id:Number(task.user_id), budget:Number(task.budget)||0, owner_name:task.owner ? `${task.owner.first_name} ${task.owner.last_name}`.trim() : 'TaskerPH member' }));
        const metrics = metricsResult.data?.[0] || {};
        return res.status(200).json(ok('',{users,events,reports,tasks:taskItems,under_review_tasks:reviewTaskItems,trends:trendResult.data||[],has_more_tasks:tasks.length < (totalTasks.count||0),stats:{total_users:Number(metrics.account_count)||0,admin_count:Number(metrics.admin_count)||0,active_count:Number(metrics.active_count)||0,total_tasks:totalTasks.count||0,completed_tasks:completedTasks.count||0,open_tasks:openTasks.count||0,open_reports:openReportCount.count||0}}));
      }
      if (action === 'dashboard_trends') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view dashboard trends.',403);
        const days=Number(body.days||30), category=clean(body.category,80)||null;
        const categories=['Home & Repair','Cleaning Services','Moving & Transport','Delivery & Logistics','IT & Tech Support','Digital & Creative','Events & Entertainment','Errands & Shopping','Tutoring & Training','Beauty & Wellness','Pet Care','Business Services'];
        if (![7,30,90].includes(days) || (category && !categories.includes(category))) throw fail('Choose a valid trend period and task category.',422);
        const {data,error}=await s.rpc('admin_dashboard_trends',{p_days:days,p_category:category});
        if (error) throw fail(error.message);
        return res.status(200).json(ok('',{trends:data||[]}));
      }
      if (action === 'list_users') {
        if (!canViewUsers(profile)) throw fail('You do not have permission to view account records.',403);
        const offset = Number(body.offset || 0);
        const search = clean(body.search,80).replace(/[,%()]/g,' ').replace(/\s+/g,' ').trim();
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fail('Choose a valid account page.',422);
        let query = s.from('user_profiles').select('id,first_name,middle_initial,last_name,email,role,created_at,is_suspended,suspension_reason,suspended_until',{count:'exact'}).neq('role','superadmin');
        if (profile.role === 'admin') query = query.neq('id',profile.id);
        const role = clean(body.role,20) || 'all';
        if (!['all','user','admin','moderator','support'].includes(role)) throw fail('Choose a valid account role.',422);
        if (role !== 'all') query = query.eq('role',role);
        if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
        const {data,error,count} = await query.order('created_at',{ascending:false}).range(offset,offset+49);
        if (error) throw fail(error.message);
        return res.status(200).json(ok('',{users:(data||[]).map((user)=>({...user,id:Number(user.id),is_suspended:suspensionIsActive(user)})),total_count:count||0,has_more:offset+(data||[]).length<(count||0)}));
      }
      if (action === 'list_reports') {
        if (!canReviewReports(profile)) throw fail('You do not have permission to review task reports.',403);
        const offset = Number(body.offset || 0);
        const status = clean(body.status,20) || 'all';
        const reason = clean(body.reason,80) || 'all';
        const search = clean(body.search,80).replace(/[,%()]/g,' ').replace(/\s+/g,' ').trim();
        const from = clean(body.from,10), to = clean(body.to,10);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fail('Choose a valid report page.',422);
        if (!['all','Open','Reviewed','Dismissed'].includes(status)) throw fail('Choose a valid report status.',422);
        if (!['all','Scam or fraud','Inappropriate content','Misleading information','Other'].includes(reason)) throw fail('Choose a valid report reason.',422);
        const isDate = (value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)));
        if (!isDate(from) || !isDate(to) || (from && to && from > to)) throw fail('Choose a valid report date range.',422);
        let query = s.from('task_reports').select('id,task_id,reporter_id,reason,details,status,created_at,resolution_note,reviewed_at,task:tasks!task_reports_task_id_fkey(id,user_id,title,description,category,status,budget,location,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)),reporter:user_profiles!task_reports_reporter_id_fkey(id,first_name,last_name,email)',{count:'exact'});
        if (status !== 'all') query = query.eq('status',status);
        if (reason !== 'all') query = query.eq('reason',reason);
        if (from) query = query.gte('created_at',`${from}T00:00:00.000Z`);
        if (to) {
          const dayAfter = new Date(`${to}T00:00:00.000Z`);
          dayAfter.setUTCDate(dayAfter.getUTCDate()+1);
          query = query.lt('created_at',dayAfter.toISOString());
        }
        if (search) {
          const safeSearch = search.replace(/[%_]/g,' ');
          const filters = [`reason.ilike.%${safeSearch}%`,`details.ilike.%${safeSearch}%`];
          const matchingTasks = await rows(s.from('tasks').select('id').ilike('title',`%${safeSearch}%`).limit(500));
          const matchingReporters = await rows(s.from('user_profiles').select('id').or(`first_name.ilike.%${safeSearch}%,last_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`).limit(500));
          if (matchingTasks.length) filters.push(`task_id.in.(${matchingTasks.map((task)=>Number(task.id)).join(',')})`);
          if (matchingReporters.length) filters.push(`reporter_id.in.(${matchingReporters.map((user)=>Number(user.id)).join(',')})`);
          query = query.or(filters.join(','));
        }
        const {data,error,count} = await query.order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+49);
        if (error) throw fail(error.message);
        const taskIds=[...new Set((data||[]).map((report)=>Number(report.task_id)).filter((id)=>id>0))];
        const relatedReports=[];
        if (taskIds.length) {
          for (let relatedOffset=0;;relatedOffset+=1000) {
            const batch=await rows(s.from('task_reports').select('task_id,status').in('task_id',taskIds).range(relatedOffset,relatedOffset+999));
            relatedReports.push(...batch);
            if (batch.length<1000) break;
          }
        }
        const counts=new Map();
        for (const report of relatedReports) {
          const key=Number(report.task_id), current=counts.get(key)||{total:0,open:0};
          current.total+=1;
          if (report.status==='Open') current.open+=1;
          counts.set(key,current);
        }
        const reportItems=(data||[]).map((report)=>({...report,task_report_count:counts.get(Number(report.task_id))?.total||1,task_open_report_count:counts.get(Number(report.task_id))?.open||0}));
        return res.status(200).json(ok('',{reports:reportItems,total_count:count||0,has_more:offset+(data||[]).length<(count||0)}));
      }
      if (action === 'list_audit') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view the audit log.',403);
        const offset = Number(body.offset || 0);
        const search = clean(body.search,80).replace(/[,%()]/g,' ').replace(/\s+/g,' ').trim();
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fail('Choose a valid audit page.',422);
        let query = s.from('admin_audit_events').select('*',{count:'exact'});
        if (search) query = query.or(`actor_name.ilike.%${search}%,actor_email.ilike.%${search}%,action.ilike.%${search}%,target_label.ilike.%${search}%,reason.ilike.%${search}%`);
        const {data,error,count} = await query.order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+49);
        if (error) throw fail(error.message);
        return res.status(200).json(ok('',{events:data||[],total_count:count||0,has_more:offset+(data||[]).length<(count||0)}));
      }
      if (action === 'export_audit') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can export the audit log.',403);
        const offset = Number(body.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw fail('Choose a valid audit export page.',422);
        const {data,error} = await s.from('admin_audit_events').select('*').order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+499);
        if (error) throw fail(error.message);
        return res.status(200).json(ok('',{events:data||[],has_more:(data||[]).length===500}));
      }
      if (action === 'more_tasks') {
        if (!canModerate(profile)) throw fail('Only moderation staff can load platform tasks.',403);
        const offset = Number(body.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fail('Choose a valid task page.',422);
        const search = clean(body.search,80).replace(/[^a-zA-Z0-9@.\- ]/g,' ').replace(/\s+/g,' ').trim();
        const status = clean(body.status,20) || 'all';
        if (!['all','Open','In Progress','Awaiting Confirmation','Under Review','Completed','Cancelled'].includes(status)) throw fail('Choose a valid task status.',422);
        let ownerIds = [];
        if (search) ownerIds = (await rows(s.from('user_profiles').select('id').or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`).limit(500))).map((user)=>Number(user.id));
        let taskQuery = s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)',{count:'exact'});
        if (status !== 'all') taskQuery = taskQuery.eq('status',status);
        if (search) {
          const filters = [`title.ilike.%${search}%`,`category.ilike.%${search}%`,`location.ilike.%${search}%`,`description.ilike.%${search}%`];
          const loweredSearch = search.toLowerCase();
          if ('open'.includes(loweredSearch)) filters.push('status.eq.Open');
          if ('in progress'.includes(loweredSearch)) filters.push('status.eq."In Progress"');
          if ('completed'.includes(loweredSearch)) filters.push('status.eq.Completed');
          if (/^\d+$/.test(search)) filters.push(`id.eq.${Number(search)}`);
          if (ownerIds.length) filters.push(`user_id.in.(${ownerIds.join(',')})`);
          taskQuery = taskQuery.or(filters.join(','));
        }
        const {data:rowsFound,error,count} = await taskQuery.order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+49);
        if (error) throw fail(error.message);
        const taskItems = (rowsFound||[]).map((task)=>({...task,id:Number(task.id),user_id:Number(task.user_id),budget:Number(task.budget)||0,owner_name:task.owner?`${task.owner.first_name} ${task.owner.last_name}`.trim():'TaskerPH member'}));
        const totalCount = count||0;
        return res.status(200).json(ok('',{tasks:taskItems,total_count:totalCount,has_more_tasks:offset+taskItems.length<totalCount}));
      }
      if (action === 'view_task_details') {
        if (!canModerate(profile)) throw fail('Only moderation staff can view task details.',403);
        const taskId = Number(body.task_id);
        if (!Number.isSafeInteger(taskId) || taskId < 1) throw fail('Choose a valid task.',422);
        const [task, bids, totalBids, acceptedBids, pendingBids, rejectedBids] = await Promise.all([
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,schedule_date,task_mode,budget_type,materials_included,requirements,checklist,owner:user_profiles!tasks_user_id_fkey(id,first_name,middle_initial,last_name,email,avatar_path,role,created_at)').eq('id',taskId).maybeSingle()),
          rows(s.from('bids').select('id,task_id,bidder_id,amount,status,message,created_at,removal_reason,bidder:user_profiles!bids_bidder_id_fkey(id,first_name,middle_initial,last_name,email,avatar_path,role,created_at)').eq('task_id',taskId).order('created_at',{ascending:false}).limit(200)),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId).eq('status','Accepted'),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId).eq('status','Pending'),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId).eq('status','Rejected')
        ]);
        if (!task) throw fail('Task not found.',404);
        for (const result of [totalBids,acceptedBids,pendingBids,rejectedBids]) if(result.error) throw fail(result.error.message);
        const disputes=task.status==='Under Review'?await rows(s.from('task_disputes').select('id,opened_by,details,status,created_at,opener:user_profiles!task_disputes_opened_by_fkey(first_name,last_name,email)').eq('task_id',taskId).order('created_at',{ascending:false})):[];
        const taskData = {...task,id:Number(task.id),user_id:Number(task.user_id),budget:Number(task.budget)||0,owner:task.owner?{...task.owner,id:Number(task.owner.id),avatar_path:publicAvatarUrl(s,task.owner.avatar_path)}:null,owner_name:task.owner?`${task.owner.first_name} ${task.owner.last_name}`.trim():'TaskerPH member'};
        const bidItems = bids.map((bid)=>({...bid,id:Number(bid.id),task_id:Number(bid.task_id),bidder_id:Number(bid.bidder_id),amount:Number(bid.amount)||0,bidder:bid.bidder?{...bid.bidder,id:Number(bid.bidder.id),avatar_path:publicAvatarUrl(s,bid.bidder.avatar_path)}:null}));
        return res.status(200).json(ok('',{task:taskData,bids:bidItems,disputes,stats:{total_bids:totalBids.count||0,accepted_bids:acceptedBids.count||0,pending_bids:pendingBids.count||0,rejected_bids:rejectedBids.count||0}}));
      }
      if (action === 'view_user_profile') {
        if (!['superadmin','support','admin','moderator'].includes(profile.role)) throw fail('Only staff can view member profiles.',403);
        const userId = Number(body.user_id);
        if (!Number.isSafeInteger(userId) || userId < 1) throw fail('Choose a valid account.',422);
        const [account, tasks, totalTasks, completedTasks, presence, recentActivity, submittedBids, totalBids, acceptedBids] = await Promise.all([
          rows(s.from('user_profiles').select('id,first_name,middle_initial,last_name,email,role,avatar_path,created_at').eq('id',userId).maybeSingle()),
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at').eq('user_id',userId).order('created_at',{ascending:false}).limit(25)),
          s.from('tasks').select('id',{count:'exact',head:true}).eq('user_id',userId),
          s.from('tasks').select('id',{count:'exact',head:true}).eq('user_id',userId).eq('status','Completed'),
          rows(s.from('account_presence').select('last_login_at,last_seen_at').eq('user_id',userId).maybeSingle()),
          rows(s.from('account_activity').select('id,event_type,summary,created_at').eq('user_id',userId).order('created_at',{ascending:false}).limit(10)),
          rows(s.from('bids').select('id,task_id,amount,message,status,created_at,task:tasks!bids_task_id_fkey(id,title,category,status,budget,location,owner:user_profiles!tasks_user_id_fkey(first_name,last_name))').eq('bidder_id',userId).order('created_at',{ascending:false}).limit(30)),
          s.from('bids').select('id',{count:'exact',head:true}).eq('bidder_id',userId),
          s.from('bids').select('id',{count:'exact',head:true}).eq('bidder_id',userId).eq('status','Accepted')
        ]);
        if (!account) throw fail('Account not found.',404);
        for (const result of [totalTasks,completedTasks,totalBids,acceptedBids]) if (result.error) throw fail(result.error.message);
        const profileData = {...account,id:Number(account.id),...(presence||{last_login_at:null,last_seen_at:null})};
        const taskItems = tasks.map((task)=>({...task,id:Number(task.id),user_id:Number(task.user_id),budget:Number(task.budget)||0,owner_name:`${account.first_name} ${account.last_name}`.trim(),owner:{first_name:account.first_name,last_name:account.last_name,email:account.email}}));
        const bidItems = submittedBids.map((bid)=>({...bid,id:Number(bid.id),task_id:Number(bid.task_id),amount:Number(bid.amount)||0}));
        return res.status(200).json(ok('',{profile:profileData,tasks:taskItems,submitted_bids:bidItems,recent_activity:recentActivity,stats:{total_tasks:totalTasks.count||0,completed_tasks:completedTasks.count||0,total_bids:totalBids.count||0,accepted_bids:acceptedBids.count||0}}));
      }
      if (action === 'submit_report') {
        const taskId=Number(body.task_id), reason=clean(body.reason,80), details=clean(body.details,1000);
        if (!Number.isSafeInteger(taskId) || !['Scam or fraud','Inappropriate content','Misleading information','Other'].includes(reason)) throw fail('Choose a valid report reason.',422);
        const task=await rows(s.from('tasks').select('id,title').eq('id',taskId).maybeSingle()); if(!task) throw fail('Task not found.',404);
        const previousReport=await rows(s.from('task_reports').select('id').eq('task_id',taskId).eq('reporter_id',profile.id).maybeSingle());
        if (previousReport) throw fail('You have already reported this task. You can submit only one report per task.',409);
        const {data:report,error:reportError}=await s.from('task_reports').insert({task_id:taskId,reporter_id:profile.id,reason,details}).select('id').single();
        if (reportError?.code==='23505') throw fail('You have already reported this task. You can submit only one report per task.',409);
        if (reportError || !report) throw fail(reportError?.message || 'Your report could not be submitted.',400);
        await logActivity(s,profile.id,'report_submitted',`Report submitted for: ${task.title}`,'report',report.id);
        return res.status(200).json(ok('Report sent to the Superadmin for review.'));
      }
      if (action === 'review_report') {
        if (!canReviewReports(profile)) throw fail('You do not have permission to review reports.',403);
        const id=Number(body.report_id), status=body.status, note=clean(body.note,1000);
        if (!Number.isSafeInteger(id) || !['Reviewed','Dismissed'].includes(status)) throw fail('Choose a valid report status.',422);
        if (!note) throw fail('Add a resolution note before closing the report.',422);
        const report = await rows(s.from('task_reports').select('id,task_id,status,resolution_note,task:tasks!task_reports_task_id_fkey(title)').eq('id',id).maybeSingle());
        if (!report) throw fail('Report not found.',404);
        await rows(s.from('task_reports').update({status,resolution_note:note,reviewed_by:Number(profile.id),reviewed_at:new Date().toISOString()}).eq('id',id));
        await recordAdminAudit(s,profile,{action:'report_reviewed',target_type:'report',target_id:id,target_label:report.task?.title||`Report #${id}`,reason:note,before_state:{status:report.status,resolution_note:report.resolution_note||''},after_state:{status,resolution_note:note}});
        await logActivity(s,profile.id,'report_reviewed',`Report #${id} marked ${status.toLowerCase()}`,'report',id);
        return res.status(200).json(ok('Report updated.'));
      }
      if (action === 'suspend_user' || action === 'unsuspend_user') {
        const isAdminSuspendingMember=profile.role==='admin'&&action==='suspend_user'&&canViewUsers(profile);
        if (profile.role !== 'superadmin'&&!isAdminSuspendingMember) throw fail('Only the Superadmin can manage account suspensions. Admins may suspend member accounts when they have user-record access.',403);
        const targetId = Number(body.user_id);
        if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === Number(profile.id)) throw fail('Choose a valid account to manage.',422);
        const target = await rows(s.from('user_profiles').select('id,first_name,last_name,email,role,is_suspended,suspension_reason,suspended_until').eq('id',targetId).maybeSingle());
        if (!target) throw fail('Account not found.',404);
        if (target.role === 'superadmin') throw fail('Superadmin accounts cannot be suspended.',403);
        if (isAdminSuspendingMember&&target.role!=='user') throw fail('Admins may suspend member accounts only.',403);
        const label = `${target.first_name} ${target.last_name}`.trim();
        if (action === 'unsuspend_user') {
          if (!target.is_suspended) throw fail('This account is not suspended.',409);
          await rows(s.from('user_profiles').update({is_suspended:false,suspension_reason:null,suspended_until:null}).eq('id',targetId));
          await recordAdminAudit(s,profile,{action:'account_unsuspended',target_type:'user',target_id:targetId,target_label:label,reason:clean(body.reason,1000),before_state:{is_suspended:true,suspension_reason:target.suspension_reason,suspended_until:target.suspended_until},after_state:{is_suspended:false}});
          await logActivity(s,profile.id,'account_unsuspended',`Reactivated account: ${label}`,'user',targetId);
          return res.status(200).json(ok('Account reactivated.'));
        }
        const reason = clean(body.reason,1000), duration = clean(body.duration,20);
        if (!reason) throw fail('Enter a reason for the suspension.',422);
        if (!['24h','7d','30d','permanent'].includes(duration)) throw fail('Choose a valid suspension duration.',422);
        const until = duration === 'permanent' ? null : new Date(Date.now() + ({'24h':24,'7d':168,'30d':720}[duration] * 60 * 60 * 1000)).toISOString();
        await rows(s.from('user_profiles').update({is_suspended:true,suspension_reason:reason,suspended_until:until}).eq('id',targetId));
        await recordAdminAudit(s,profile,{action:'account_suspended',target_type:'user',target_id:targetId,target_label:label,reason,before_state:{is_suspended:Boolean(target.is_suspended),suspended_until:target.suspended_until},after_state:{is_suspended:true,suspended_until:until}});
        await logActivity(s,profile.id,'account_suspended',`Suspended account: ${label}`,'user',targetId);
        return res.status(200).json(ok(until ? `Account suspended until ${new Date(until).toLocaleString('en-PH')}.` : 'Account suspended indefinitely.'));
      }
      if (action === 'update_user') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can edit user accounts.',403);
        const targetId = Number(body.user_id);
        if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === Number(profile.id)) throw fail('Choose a valid account to edit.',422);
        const target = await rows(s.from('user_profiles').select('id,auth_user_id,first_name,middle_initial,last_name,email,role').eq('id',targetId).maybeSingle());
        if (!target) throw fail('Account not found.',404);
        if (target.role === 'superadmin') throw fail('Superadmin accounts cannot be edited from User Management.',403);
        const first_name = clean(body.first_name,80), middle_initial = clean(body.middle_initial,1), last_name = clean(body.last_name,80);
        const email = clean(body.email,190).toLowerCase(), role = clean(body.role,20);
        if (!first_name || !last_name) throw fail('Enter the user’s first and last name.',422);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email address.',422);
        if (!['user','admin','moderator','support'].includes(role)) throw fail('Choose a valid account role.',422);
        if (email !== String(target.email).toLowerCase()) {
          const { error } = await s.auth.admin.updateUserById(target.auth_user_id,{email,email_confirm:true});
          if (error) throw fail(error.message,400);
        }
        const [updated] = await rows(s.from('user_profiles').update({first_name,middle_initial,last_name,email,role}).eq('id',targetId).select('id,first_name,middle_initial,last_name,email,role,created_at').limit(1));
        if (!updated) throw fail('The account could not be updated.',500);
        await recordAdminAudit(s,profile,{action:'user_updated',target_type:'user',target_id:targetId,target_label:`${first_name} ${last_name}`,reason:clean(body.reason,1000),before_state:{role:target.role,email:target.email},after_state:{role,email}});
        await logActivity(s,profile.id,'user_updated',`Updated account: ${first_name} ${last_name} (${role})`,'user',targetId);
        return res.status(200).json(ok('User account updated.',{user:{...updated,id:Number(updated.id)}}));
      }
      if (action === 'delete_user') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can delete accounts.',403);
        const targetId=Number(body.user_id);
        if (!Number.isSafeInteger(targetId) || targetId === Number(profile.id)) throw fail('You cannot delete your own account.',422);
        const target=await rows(s.from('user_profiles').select('id,auth_user_id,first_name,last_name,role').eq('id',targetId).maybeSingle());
        if (!target) throw fail('Account not found.',404);
        if (target.role === 'superadmin') throw fail('Superadmin accounts are protected from deletion.',403);
        const reason=clean(body.reason,1000);
        if (!reason) throw fail('Enter a reason before permanently deleting this account.',422);
        await recordAdminAudit(s,profile,{action:'user_deleted',target_type:'user',target_id:target.id,target_label:`${target.first_name} ${target.last_name}`,reason,before_state:{role:target.role}});
        const {error}=await s.auth.admin.deleteUser(target.auth_user_id);
        if(error) throw fail(error.message,400);
        await logActivity(s,profile.id,'user_deleted',`Deleted account: ${target.first_name} ${target.last_name} (${target.role})`,'user',target.id);
        return res.status(200).json(ok('User account deleted.'));
      }
      if (action==='create_admin') {
        if(profile.role!=='superadmin') throw fail('Only the Superadmin can create Admin accounts.',403);
        const role = clean(body.role,20) || 'admin';
        if (!['admin','moderator','support'].includes(role)) throw fail('Choose a valid staff role.',422);
        const {data,error}=await s.auth.admin.createUser({email:clean(body.email,190).toLowerCase(),password:String(body.password||''),email_confirm:true,user_metadata:{first_name:clean(body.first_name,80),middle_initial:clean(body.middle_initial,1),last_name:clean(body.last_name,80)}});
        if(error) throw fail(error.message,400);
        const [created] = await rows(s.from('user_profiles').update({role}).eq('auth_user_id',data.user.id).select('id,first_name,last_name,email').limit(1));
        if (!created) throw fail('The staff profile could not be assigned its role.',500);
        await recordAdminAudit(s,profile,{action:'staff_created',target_type:'user',target_id:created.id,target_label:`${created.first_name} ${created.last_name}`,reason:'Staff account provisioned',after_state:{role,email:created.email}});
        return res.status(200).json(ok(`${role[0].toUpperCase()}${role.slice(1)} account provisioned.`));
      }
      const id=Number(body.task_id); const taskColumns=action==='update_task'?'user_id,image_urls,status,title,category,budget,location,description':(['delete_task','reopen_task'].includes(action)?'user_id,image_urls,status,title':'user_id'); const t=await rows(s.from('tasks').select(taskColumns).eq('id',id).maybeSingle());
      if(!t || (!isMod(profile)&&Number(t.user_id)!==Number(profile.id))) throw fail('You can only manage your own task postings.',403);
      if(action==='delete_task') {
        if(t.status==='Completed'&&!isMod(profile)) throw fail('Completed tasks cannot be deleted by their owner.',409);
        if (isMod(profile) && Number(t.user_id) !== Number(profile.id)) {
          const reason=clean(body.reason,1000);
          if (!reason) throw fail('A moderation reason is required to remove another member’s task.',422);
          const taskSnapshot = await rows(s.from('tasks').select('title,status,user_id').eq('id',id).maybeSingle());
          await recordAdminAudit(s,profile,{action:'task_removed',target_type:'task',target_id:id,target_label:taskSnapshot?.title||`Task #${id}`,reason,before_state:taskSnapshot?{status:taskSnapshot.status,owner_id:taskSnapshot.user_id}:null});
        }
        await rows(s.from('tasks').delete().eq('id',id));
        const bucketPrefix=`${url.replace(/\/$/,'')}/storage/v1/object/public/task-photos/`;
        const photoPaths=(Array.isArray(t.image_urls)?t.image_urls:[]).filter((photoUrl)=>photoUrl.startsWith(bucketPrefix)).map((photoUrl)=>decodeURIComponent(photoUrl.slice(bucketPrefix.length).split('?')[0]));
        if(photoPaths.length) await s.storage.from('task-photos').remove(photoPaths).catch(()=>{});

        return res.status(200).json(ok('Task removed from the marketplace.'));
      }
      if(action==='reopen_task') {
        if(t.status!=='Cancelled') throw fail('Only a cancelled task can be reopened.',409);
        // Retire the former assignment before making the listing available again.
        // This also repairs older cancelled tasks whose accepted bid was left active.
        await rows(s.from('bids').update({status:'Cancelled'}).eq('task_id',id).eq('status','Accepted'));
        const reopened=await rows(s.from('tasks').update({status:'Open',completion_requested_at:null,completion_confirmed_at:null}).eq('id',id).eq('status','Cancelled').select('id'));
        if(!reopened.length) throw fail('The task status changed. Refresh and try again.',409);
        await logActivity(s,profile.id,'task_reopened',`Reopened cancelled task #${id}`,'task',id);
        return res.status(200).json(ok('Task reopened. It is now accepting bids again.'));
      }
      if(action==='update_task') {
        const allowedTaskStatuses=['Open','In Progress','Awaiting Confirmation','Under Review','Completed','Cancelled'];
        if (isMod(profile) && body.status && !allowedTaskStatuses.includes(body.status)) throw fail('Choose a valid task status.',422);
        const patch={title:clean(body.title,180),category:clean(body.category,80),budget:Number(body.budget),location:clean(body.location,160),description:clean(body.description,2000),status:isMod(profile)&&allowedTaskStatuses.includes(body.status)?body.status:t.status,schedule_date:body.schedule_date||null,task_mode:['on_site','online','hybrid'].includes(body.task_mode)?body.task_mode:'on_site',budget_type:['fixed','negotiable'].includes(body.budget_type)?body.budget_type:'fixed',materials_included:body.materials_included===true||body.materials_included==='on',requirements:clean(body.requirements,1500),checklist:Array.isArray(body.checklist)?body.checklist.slice(0,20).map((value)=>clean(value,180)).filter(Boolean):[]};
        if (patch.schedule_date) { const date = new Date(`${patch.schedule_date}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.schedule_date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== patch.schedule_date) throw fail('Choose a valid preferred date.',422); }
        const photos=Array.isArray(body.photos)?body.photos:[];
        const oldUrls=Array.isArray(t.image_urls)?t.image_urls:[];
        const keepUrls=body.keep_image_urls===undefined?oldUrls:body.keep_image_urls;
        if(!Array.isArray(keepUrls)||photos.length>3||keepUrls.length>3||photos.some((photo)=>typeof photo!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo))) throw fail('Choose up to 3 valid task photos.',422);
        const uniqueKeepUrls=[...new Set(keepUrls)];
        if(uniqueKeepUrls.length!==keepUrls.length||uniqueKeepUrls.some((photoUrl)=>!oldUrls.includes(photoUrl))) throw fail('One of the selected task photos is invalid. Refresh the page and try again.',422);
        if(uniqueKeepUrls.length+photos.length>3) throw fail('Keep or upload no more than 3 task photos.',422);
        const uploadedPaths=[];
        try {
          const newUrls=[];
          for(const photo of photos){
            const bytes=Buffer.from(photo.slice(photo.indexOf(',')+1),'base64');
            if(!bytes.length||bytes.length>450*1024) throw fail('Each task photo must be smaller than 450 KB after compression.',422);
            const path=`${profile.id}/${id}/${randomUUID()}.jpg`;
            const {error}=await s.storage.from('task-photos').upload(path,bytes,{contentType:'image/jpeg',upsert:false});
            if(error) throw fail('Could not upload a task photo. Confirm the task-photos bucket migration is applied.',500);
            uploadedPaths.push(path);
            newUrls.push(s.storage.from('task-photos').getPublicUrl(path).data.publicUrl);
          }
          patch.image_urls=[...uniqueKeepUrls,...newUrls];
          await rows(s.from('tasks').update(patch).eq('id',id));
          if (patch.status === 'Completed' && t.status !== 'Completed') await logActivity(s,profile.id,'task_completed',`Task completed: ${patch.title}`,'task',id);
          if (isMod(profile) && Number(t.user_id) !== Number(profile.id)) {
            await recordAdminAudit(s,profile,{action:'task_updated',target_type:'task',target_id:id,target_label:patch.title,reason:clean(body.reason,1000),before_state:{title:t.title,category:t.category,budget:Number(t.budget),location:t.location,description:t.description,status:t.status},after_state:{title:patch.title,category:patch.category,budget:patch.budget,location:patch.location,description:patch.description,status:patch.status}});
          }
        } catch(error) {
          if(uploadedPaths.length) await s.storage.from('task-photos').remove(uploadedPaths).catch(()=>{});
          throw error;
        }
        const bucketPrefix=`${url.replace(/\/$/,'')}/storage/v1/object/public/task-photos/`;
        const removedPaths=oldUrls.filter((photoUrl)=>!uniqueKeepUrls.includes(photoUrl)&&photoUrl.startsWith(bucketPrefix)).map((photoUrl)=>decodeURIComponent(photoUrl.slice(bucketPrefix.length).split('?')[0]));
        if(removedPaths.length) await s.storage.from('task-photos').remove(removedPaths).catch(()=>{});

        return res.status(200).json(ok('Task updated.'));
      }
    }
    if (route === 'bid_actions') {
      ({ profile } = await userFor(req,s, action !== 'my_bids' && action !== 'list'));
      if(action==='my_bids') { const bids=await loadMyBids(s,profile); return res.status(200).json(ok('',{bids})); }
      const taskId=Number(body.task_id||query.get('task_id')); const task=await rows(s.from('tasks').select('*').eq('id',taskId).maybeSingle()); if(!task) throw fail('Task not found.',404);
      if(action==='task_details') {
        const isOwner=Number(task.user_id)===Number(profile.id);
        const linkedBid=isOwner||isMod(profile)?true:await rows(s.from('bids').select('id').eq('task_id',taskId).eq('bidder_id',profile.id).maybeSingle());
        if(!linkedBid) throw fail('Only a participant in this task can view its details.',403);
        const owner=await rows(s.from('user_profiles').select('first_name,last_name').eq('id',task.user_id).maybeSingle());
        return res.status(200).json(ok('',{task:{...task,id:Number(task.id),user_id:Number(task.user_id),budget:Number(task.budget)||0,owner_name:owner?`${owner.first_name} ${owner.last_name}`.trim():'TaskerPH member'}}));
      }
      if(action==='list') { const bids=await loadTaskBids(s,task,profile); return res.status(200).json(ok('',{bids})); }
      if(action==='place') { if(Number(task.user_id)===Number(profile.id)) throw fail('You cannot bid on your own task.',403); if(task.status!=='Open') throw fail('This task is no longer accepting bids.',409); const accepted=await rows(s.from('bids').select('task_id').eq('bidder_id',profile.id).eq('status','Accepted')); const acceptedTaskIds=[...new Set(accepted.map((bid)=>Number(bid.task_id)))]; const activeAcceptedTasks=acceptedTaskIds.length?await rows(s.from('tasks').select('id').in('id',acceptedTaskIds).in('status',['In Progress','Awaiting Confirmation','Under Review'])):[]; if(activeAcceptedTasks.length) throw fail('You already have an accepted task in progress. Complete or resolve it before bidding on another task.',409); const amount=Number(body.amount),message=clean(body.message,1000);if(!Number.isFinite(amount)||amount<0||!message)throw fail('Enter a valid offer and message.',422); const [placedBid]=await rows(s.from('bids').upsert({task_id:taskId,bidder_id:profile.id,amount,message,status:'Pending'},{onConflict:'task_id,bidder_id'}).select('id')); await taskNotice(s,task.user_id,taskId,'bid_received','New bid received',`${profile.first_name} ${profile.last_name} offered ${new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(amount)} for “${task.title}”.`,`bid:${placedBid.id}:received:${randomUUID()}`); return res.status(200).json(ok('Your bid has been submitted.')); }
      const bidId=Number(body.bid_id);
      if(action==='update') {const amount=Number(body.amount),message=clean(body.message,1000);if(!Number.isFinite(amount)||amount<0||!message||task.status!=='Open')throw fail('Enter a valid offer and message.',422);const updated=await rows(s.from('bids').update({amount,message}).eq('id',bidId).eq('task_id',taskId).eq('bidder_id',profile.id).eq('status','Pending').select('id'));if(!updated.length)throw fail('Only your pending bid on an open task can be edited.',403);return res.status(200).json(ok('Your bid was updated.')); }
      if(action==='delete') {const bid=await rows(s.from('bids').select('id').eq('id',bidId).eq('task_id',taskId).eq('bidder_id',profile.id).eq('status','Pending').maybeSingle());if(!bid||task.status!=='Open')throw fail('Only your pending bid on an open task can be deleted.',403);await rows(s.from('messages').delete().eq('task_id',taskId).or(`sender_id.eq.${profile.id},recipient_id.eq.${profile.id}`));await rows(s.from('bids').delete().eq('id',bidId).eq('task_id',taskId).eq('bidder_id',profile.id));return res.status(200).json(ok('Your bid was deleted.')); }
      if(action==='accept') {
        if(Number(task.user_id)!==Number(profile.id)&&!isMod(profile)) throw fail('Only the task owner or a moderator can accept a bid.',403);
        const assignment=await rows(s.rpc('accept_task_bid',{p_task_id:taskId,p_bid_id:bidId}));
        const selected=assignment.find((item)=>item.was_selected);
        if(!selected) throw fail('This task could not be assigned. Refresh and try again.',409);
        await taskNotice(s,selected.bidder_id,taskId,'bid_accepted','Your bid was accepted',`You were selected for “${task.title}”. Message the poster to confirm the schedule.`,`task:${taskId}:accepted:${randomUUID()}`);
        for (const item of assignment.filter((entry)=>!entry.was_selected)) await taskNotice(s,item.bidder_id,taskId,'bid_not_selected','Another tasker was selected',`The poster selected another tasker for “${task.title}”.`,`task:${taskId}:not-selected:${item.bidder_id}:${randomUUID()}`);
        await logActivity(s,profile.id,'bid_accepted',`Tasker selected for: ${task.title}`,'task',taskId);
        return res.status(200).json(ok('Bid accepted. The task is now in progress, and both sides have been notified.'));
      }
      if(action==='remove_bid') {if(Number(task.user_id)!==Number(profile.id)&&!isMod(profile)) throw fail('Only the task owner or a moderator can remove a bidder.',403);const reason=clean(body.reason,1000);if(!reason)throw fail('Please provide a reason for removing the bidder.',422);const removed=await rows(s.from('bids').update({status:'Pending',removal_reason:reason}).eq('id',bidId).eq('task_id',taskId).eq('status','Pending').select('id'));if(!removed.length)throw fail('Only pending bids can be removed here. Use the task assignment controls to cancel an accepted assignment.',409);return res.status(200).json(ok('The bidder was removed and the reason was saved.'));}
    }
    if (route === 'task_lifecycle') {
      ({ profile } = await userFor(req,s,true));
      const taskId=Number(body.task_id);
      if(!Number.isSafeInteger(taskId)||taskId<1) throw fail('A valid task ID is required. Refresh the task and try again.',422);
      const task=await rows(s.from('tasks').select('id,user_id,title,status,completion_requested_at,bids(id,bidder_id,status)').eq('id',taskId).maybeSingle());
      if(!task) throw fail('Task not found.',404);
      const acceptedBid=(task.bids||[]).find((bid)=>bid.status==='Accepted');
      if(!acceptedBid) throw fail('This task has no accepted tasker.',409);
      const posterId=Number(task.user_id), taskerId=Number(acceptedBid.bidder_id), isPoster=Number(profile.id)===posterId, isTasker=Number(profile.id)===taskerId;
      if(action==='mark_done') {
        if(!isTasker) throw fail('Only the selected tasker can request completion.',403);
        if(task.status!=='In Progress') throw fail('This task is not ready to be marked done.',409);
        const now=new Date().toISOString();
        const changed=await rows(s.from('tasks').update({status:'Awaiting Confirmation',completion_requested_at:now,completion_confirmed_at:null}).eq('id',taskId).eq('status','In Progress').select('id'));
        if(!changed.length) throw fail('The task status changed. Refresh and try again.',409);
        await taskNotice(s,posterId,taskId,'completion_requested','Tasker marked the task done',`Please confirm or report a problem with “${task.title}”.`,`task:${taskId}:completion-request:${now}`);
        await logActivity(s,profile.id,'task_completion_requested',`Tasker marked done: ${task.title}`,'task',taskId);
        return res.status(200).json(ok('Completion requested. The task poster has been notified.'));
      }
      if(action==='confirm_completion') {
        if(!isPoster) throw fail('Only the task poster can confirm completion.',403);
        if(task.status!=='Awaiting Confirmation') throw fail('There is no completion request waiting for confirmation.',409);
        const now=new Date().toISOString();
        const changed=await rows(s.from('tasks').update({status:'Completed',completion_confirmed_at:now}).eq('id',taskId).eq('status','Awaiting Confirmation').select('id'));
        if(!changed.length) throw fail('The task status changed. Refresh and try again.',409);
        await rows(s.from('task_disputes').update({status:'Resolved',resolution:'Poster confirmed completion',resolved_by:profile.id,resolved_at:now}).eq('task_id',taskId).eq('status','Open'));
        await taskNotice(s,taskerId,taskId,'completion_confirmed','Task completion confirmed',`The poster confirmed “${task.title}”. You can now leave each other a review.`,`task:${taskId}:completion-confirmed`);
        await logActivity(s,profile.id,'task_completed',`Task completion confirmed: ${task.title}`,'task',taskId);
        return res.status(200).json(ok('Completion confirmed. The task is complete, and both sides can now leave a review.'));
      }
      if(action==='report_problem') {
        if(!isPoster&&!isTasker) throw fail('Only the task poster or selected tasker can report a problem.',403);
        if(!['In Progress','Awaiting Confirmation'].includes(task.status)) throw fail('A problem can only be reported while the task is in progress or awaiting confirmation.',409);
        const details=clean(body.details,2000);
        if(details.length<10) throw fail('Please describe the problem in at least 10 characters.',422);
        const paused=await rows(s.from('tasks').update({status:'Under Review'}).eq('id',taskId).in('status',['In Progress','Awaiting Confirmation']).select('id'));
        if(!paused.length) throw fail('The task status changed. Refresh and try again.',409);
        try { await rows(s.from('task_disputes').insert({task_id:taskId,opened_by:profile.id,details})); }
        catch(error) { await rows(s.from('tasks').update({status:task.status}).eq('id',taskId).eq('status','Under Review')).catch(()=>{}); throw error; }
        const recipient=isPoster?taskerId:posterId;
        await taskNotice(s,recipient,taskId,'task_problem_reported','A task problem was reported',`A participant reported a problem with “${task.title}”. The task is paused for review.`,`task:${taskId}:problem:${Date.now()}`);
        await logActivity(s,profile.id,'task_problem_reported',`Problem reported for: ${task.title}`,'task',taskId);
        return res.status(200).json(ok('Problem reported. The task is paused while the issue is reviewed.'));
      }
      if(action==='cancel_assignment') {
        if(!isPoster&&!isTasker) throw fail('Only the task poster or selected tasker can cancel this assignment.',403);
        if(!['In Progress','Awaiting Confirmation'].includes(task.status)) throw fail('This assignment cannot be cancelled in its current status.',409);
        if(!Number.isSafeInteger(Number(acceptedBid.id))||Number(acceptedBid.id)<1) throw fail('The accepted bid could not be identified. Refresh the task and try again.',409);
        const now=new Date().toISOString(), reason=clean(body.reason,500);
        const changed=await rows(s.from('tasks').update({status:'Cancelled'}).eq('id',taskId).in('status',['In Progress','Awaiting Confirmation']).select('id'));
        if(!changed.length) throw fail('The task status changed. Refresh and try again.',409);
        const cancelledBid=await rows(s.from('bids').update({status:'Cancelled'}).eq('task_id',taskId).eq('id',acceptedBid.id).eq('status','Accepted').select('id'));
        if(!cancelledBid.length) throw fail('The accepted bid changed before cancellation. Refresh and try again.',409);
        await taskNotice(s,isPoster?taskerId:posterId,taskId,'assignment_cancelled','Task assignment cancelled',reason||`The assignment for “${task.title}” was cancelled.`,`task:${taskId}:cancelled`);
        await logActivity(s,profile.id,'task_cancelled',`Task assignment cancelled: ${task.title}`,'task',taskId);
        return res.status(200).json(ok('Assignment cancelled. The other participant has been notified.'));
      }
      if(action==='review') {
        if(!isPoster&&!isTasker) throw fail('Only task participants can leave a review.',403);
        if(task.status!=='Completed') throw fail('Reviews are available after the poster confirms completion.',409);
        const rating=Number(body.rating), comment=clean(body.comment,1000);
        if(!Number.isInteger(rating)||rating<1||rating>5) throw fail('Choose a rating from 1 to 5 stars.',422);
        const revieweeId=isPoster?taskerId:posterId;
        await rows(s.from('task_reviews').insert({task_id:taskId,reviewer_id:profile.id,reviewee_id:revieweeId,rating,comment}));
        await taskNotice(s,revieweeId,taskId,'review_received','You received a task review',`A participant left you a ${rating}-star review for “${task.title}”.`,`task:${taskId}:review:${profile.id}`);
        await logActivity(s,profile.id,'task_reviewed',`Review submitted for: ${task.title}`,'task',taskId);
        return res.status(200).json(ok('Your review was submitted.'));
      }
      if(action==='resolve_dispute') {
        if(!canResolveDisputes(profile)) throw fail('You do not have permission to resolve disputes.',403);
        const resolutionStatus=body.status;
        if(!['In Progress','Completed','Cancelled'].includes(resolutionStatus)) throw fail('Choose a valid dispute resolution.',422);
        if(task.status!=='Under Review') throw fail('This task is not under review.',409);
        const resolution=clean(body.resolution,1000);
        if (!resolution) throw fail('Enter a resolution note before closing this dispute.',422);
        const now=new Date().toISOString();
        const resolvedTask=await rows(s.from('tasks').update({status:resolutionStatus,...(resolutionStatus==='Completed'?{completion_confirmed_at:now}:{})}).eq('id',taskId).eq('status','Under Review').select('id'));
        if(!resolvedTask.length) throw fail('The task status changed. Refresh and review the dispute again.',409);
        await recordAdminAudit(s,profile,{action:'dispute_resolved',target_type:'task',target_id:taskId,target_label:task.title,reason:resolution,before_state:{status:'Under Review'},after_state:{status:resolutionStatus,resolution}});
        await rows(s.from('task_disputes').update({status:'Resolved',resolution,resolved_by:profile.id,resolved_at:now}).eq('task_id',taskId).eq('status','Open'));
        if(resolutionStatus==='Cancelled') await rows(s.from('bids').update({status:'Cancelled'}).eq('task_id',taskId).eq('id',acceptedBid.id));
        for(const recipient of [posterId,taskerId]) await taskNotice(s,recipient,taskId,'dispute_resolved','Task issue reviewed',`The Superadmin reviewed “${task.title}”. Resolution: ${resolutionStatus}.`,`task:${taskId}:dispute-resolved:${recipient}:${randomUUID()}`);
        await logActivity(s,profile.id,'task_dispute_resolved',`Task dispute resolved: ${task.title} (${resolutionStatus})`,'task',taskId);
        return res.status(200).json(ok('Task dispute resolved.'));
      }
    }
    if (route === 'messages') {
      ({ profile } = await userFor(req,s, action !== 'list')); const taskId=Number(body.task_id||query.get('task_id')), other=Number(body.other_user_id||query.get('other_user_id'));
      const t=await rows(s.from('tasks').select('user_id,title,bids(bidder_id)').eq('id',taskId).maybeSingle());
      const linkedBidders = new Set((t?.bids || []).map((bid) => Number(bid.bidder_id)));
      const myBid = linkedBidders.has(Number(profile.id));
      const otherBid = linkedBidders.has(other);
      const permitted=t && ((Number(t.user_id)===Number(profile.id)&&otherBid) || (Number(t.user_id)===other&&myBid) || isMod(profile));
      if(!permitted) throw fail('You can only message users connected to this task.',403);
      if(action==='list') {
        const after = clean(query.get('after') || '', 50);
        const hasCursor = Boolean(after) && Number.isFinite(Date.parse(after));
        let messageQuery = s.from('messages').select('id,sender_id,recipient_id,body,read_at,created_at,sender:user_profiles!messages_sender_id_fkey(first_name,last_name)').eq('task_id',taskId).or(`and(sender_id.eq.${profile.id},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${profile.id})`).order('created_at');
        let readQuery = s.from('messages').update({read_at:new Date().toISOString()}).eq('task_id',taskId).eq('sender_id',other).eq('recipient_id',profile.id).is('read_at',null);
        if (hasCursor) { messageQuery = messageQuery.gt('created_at', after); readQuery = readQuery.gt('created_at', after); }
        const [ms] = await Promise.all([
          rows(messageQuery),
          rows(readQuery)
        ]);
        const messages=ms.map((m)=>({...m,sender_name:m.sender?`${m.sender.first_name} ${m.sender.last_name}`.trim():'TaskerPH member'}));
        return res.status(200).json(ok('',{messages}));
      }
      if(action==='send') {const text=clean(body.body,2000);if(!text)throw fail('Message cannot be empty.',422);const [message]=await rows(s.from('messages').insert({task_id:taskId,sender_id:profile.id,recipient_id:other,body:text}).select('*'));try{await sendPushToUser(s,other,`Message from ${profile.first_name} ${profile.last_name}`.trim(),'You have a new message about a task.',{type:'message',task_id:taskId,other_user_id:profile.id});}catch(pushError){console.error('Message push notification failed:',pushError.message);}return res.status(200).json(ok('Message sent.',{message}));}
    }
    if (route === 'notifications') {
      ({ profile } = await userFor(req,s, action !== 'counts' && action !== 'task_messages' && action !== 'task_updates' && action !== 'center'));
      if(action==='center') {
        const now=new Date().toISOString();
        const audience=profile.role==='user'?'members':'staff';
        const [taskNotices,messageRows,ownedTasks,announcements,announcementReads]=await Promise.all([
          rows(s.from('task_notifications').select('id,task_id,event_type,title,body,dedupe_key,is_read,created_at').eq('user_id',profile.id).order('created_at',{ascending:false}).limit(50)),
          rows(s.from('messages').select('id,task_id,sender_id,body,read_at,created_at').eq('recipient_id',profile.id).order('created_at',{ascending:false}).limit(50)),
          rows(s.from('tasks').select('id,title').eq('user_id',profile.id)),
          rows(s.from('platform_announcements').select('id,title,body,audience,starts_at,expires_at').eq('is_published',true).lte('starts_at',now).in('audience',['everyone',audience]).order('starts_at',{ascending:false}).limit(100)),
          rows(s.from('announcement_reads').select('announcement_id').eq('user_id',profile.id))
        ]);
        const activeAnnouncements=announcements.filter((item)=>!item.expires_at||new Date(item.expires_at).getTime()>Date.now());
        const readAnnouncementIds=new Set(announcementReads.map((entry)=>Number(entry.announcement_id)));
        const ownedTaskIds=ownedTasks.map((task)=>Number(task.id));
        const pendingBids=ownedTaskIds.length?await rows(s.from('bids').select('id,task_id,bidder_id,amount,created_at').in('task_id',ownedTaskIds).eq('status','Pending').order('created_at',{ascending:false}).limit(50)):[];
        const pendingBidIds=pendingBids.map((bid)=>Number(bid.id));
        const relatedTaskIds=[...new Set([...messageRows.map((message)=>Number(message.task_id)),...pendingBids.map((bid)=>Number(bid.task_id))])].filter(Boolean);
        const relatedUserIds=[...new Set([...messageRows.map((message)=>Number(message.sender_id)),...pendingBids.map((bid)=>Number(bid.bidder_id))])].filter(Boolean);
        const [bidReads, taskRows, userRows, unreadMessageCount]=await Promise.all([
          pendingBidIds.length?rows(s.from('notification_reads').select('reference_id').eq('user_id',profile.id).eq('notification_type','bid').in('reference_id',pendingBidIds)):Promise.resolve([]),
          relatedTaskIds.length?rows(s.from('tasks').select('id,title').in('id',relatedTaskIds)):Promise.resolve([]),
          relatedUserIds.length?rows(s.from('user_profiles').select('id,first_name,last_name').in('id',relatedUserIds)):Promise.resolve([]),
          s.from('messages').select('id',{count:'exact',head:true}).eq('recipient_id',profile.id).is('read_at',null)
        ]);
        if(unreadMessageCount.error) throw unreadMessageCount.error;
        const taskById=new Map([...ownedTasks,...taskRows].map((task)=>[Number(task.id),task]));
        const userById=new Map(userRows.map((user)=>[Number(user.id),user]));
        const seenBidIds=new Set(bidReads.map((row)=>Number(row.reference_id)));
        const notifiedBidIds=new Set(taskNotices.map((notice)=>/^bid:(\d+):received(?::|$)/.exec(notice.dedupe_key||'')?.[1]).filter(Boolean).map(Number));
        const items=[
          ...taskNotices.map((notice)=>({...notice,type:'task'})),
          ...messageRows.map((message)=>{
            const sender=userById.get(Number(message.sender_id));
            return {id:`message-${message.id}`,type:'message',event_type:'message',task_id:Number(message.task_id),other_user_id:Number(message.sender_id),title:`Message from ${sender?`${sender.first_name} ${sender.last_name}`.trim():'TaskerPH member'}`,body:message.body,created_at:message.created_at,is_read:Boolean(message.read_at)};
          }),
          ...pendingBids.filter((bid)=>!notifiedBidIds.has(Number(bid.id))).map((bid)=>{
            const bidder=userById.get(Number(bid.bidder_id)), task=taskById.get(Number(bid.task_id));
            return {id:`bid-${bid.id}`,type:'bid',event_type:'pending_bid',entity_id:Number(bid.id),task_id:Number(bid.task_id),title:'New bid received',body:`${bidder?`${bidder.first_name} ${bidder.last_name}`.trim():'A tasker'} offered ${new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(bid.amount)||0)} for “${task?.title||'your task'}”.`,created_at:bid.created_at,is_read:seenBidIds.has(Number(bid.id))};
          }),
          ...activeAnnouncements.map((announcement)=>({id:`announcement-${announcement.id}`,type:'announcement',event_type:'announcement',entity_id:Number(announcement.id),title:announcement.title,body:announcement.body,created_at:announcement.starts_at,is_read:readAnnouncementIds.has(Number(announcement.id))}))
        ].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,100);
        const unreadCount=taskNotices.filter((item)=>!item.is_read).length+(unreadMessageCount.count||0)+pendingBids.filter((item)=>!notifiedBidIds.has(Number(item.id))&&!seenBidIds.has(Number(item.id))).length+activeAnnouncements.filter((item)=>!readAnnouncementIds.has(Number(item.id))).length;
        return res.status(200).json(ok('',{items,unread_count:unreadCount}));
      }
      if(action==='mark_all_read') {
        const now=new Date().toISOString();
        await Promise.all([
          rows(s.from('task_notifications').update({is_read:true}).eq('user_id',profile.id).eq('is_read',false)),
          rows(s.from('messages').update({read_at:now}).eq('recipient_id',profile.id).is('read_at',null))
        ]);
        const ownedTasks=await rows(s.from('tasks').select('id').eq('user_id',profile.id));
        const ownedTaskIds=ownedTasks.map((task)=>Number(task.id));
        if(ownedTaskIds.length) {
          const pending=await rows(s.from('bids').select('id').in('task_id',ownedTaskIds).eq('status','Pending'));
          if(pending.length) await rows(s.from('notification_reads').upsert(pending.map((bid)=>({user_id:profile.id,notification_type:'bid',reference_id:bid.id})),{onConflict:'user_id,notification_type,reference_id',ignoreDuplicates:true}));
        }
        const audience=profile.role==='user'?'members':'staff';
        const announcements=await rows(s.from('platform_announcements').select('id,expires_at').eq('is_published',true).lte('starts_at',now).in('audience',['everyone',audience]).limit(100));
        const activeAnnouncements=announcements.filter((entry)=>!entry.expires_at||new Date(entry.expires_at).getTime()>Date.now());
        if(activeAnnouncements.length) await rows(s.from('announcement_reads').upsert(activeAnnouncements.map((entry)=>({user_id:profile.id,announcement_id:entry.id})),{onConflict:'announcement_id,user_id',ignoreDuplicates:true}));
        return res.status(200).json(ok('All notifications marked as read.'));
      }
      if(action==='read_item' && body.type==='task') {
        await rows(s.from('task_notifications').update({is_read:true}).eq('id',Number(body.id)).eq('user_id',profile.id));
        return res.status(200).json(ok());
      }
      if(action==='read_item' && body.type==='announcement') {
        const id=Number(body.id);
        if(!Number.isSafeInteger(id)||id<1) throw fail('Choose a valid announcement.',422);
        const announcement=await rows(s.from('platform_announcements').select('id').eq('id',id).eq('is_published',true).maybeSingle());
        if(!announcement) throw fail('Announcement not found.',404);
        await rows(s.from('announcement_reads').upsert({announcement_id:id,user_id:profile.id},{onConflict:'announcement_id,user_id'}));
        return res.status(200).json(ok());
      }
      if(action==='task_updates') {
        const cutoff=new Date(Date.now()-24*60*60*1000).toISOString();
        const overdue=await rows(s.from('tasks').select('id,title,user_id').eq('user_id',profile.id).eq('status','Awaiting Confirmation').lt('completion_requested_at',cutoff));
        for(const task of overdue) await taskNotice(s,profile.id,task.id,'completion_reminder','Reminder: task needs your confirmation',`Please confirm the tasker’s completion of “${task.title}” or report a problem.`,`task:${task.id}:completion-reminder`);
        const updates=await rows(s.from('task_notifications').select('id,task_id,event_type,title,body,created_at').eq('user_id',profile.id).eq('is_read',false).order('created_at',{ascending:false}).limit(20));
        const safeUpdates=updates.map((item)=>({ ...item, title:!item.title||['undefined','null'].includes(String(item.title).toLowerCase())?'Task update':item.title, body:!item.body||['undefined','null'].includes(String(item.body).toLowerCase())?'There is a new update about one of your tasks.':item.body }));
        return res.status(200).json(ok('',{updates:safeUpdates}));
      }
      if(action==='counts') {const tasks=await rows(s.from('tasks').select('id').eq('user_id',profile.id));const ownedIds=tasks.map(x=>x.id);const bidderLinks=await rows(s.from('bids').select('task_id').eq('bidder_id',profile.id));const bidderIds=[...new Set(bidderLinks.map(x=>x.task_id))];let pending=0,unread=0;if(ownedIds.length){const bs=await rows(s.from('bids').select('id,task_id').in('task_id',ownedIds).eq('status','Pending'));const reads=await rows(s.from('notification_reads').select('reference_id').eq('user_id',profile.id));const seen=new Set(reads.map(x=>x.reference_id));pending=bs.filter(x=>!seen.has(x.id)).length;}if(bidderIds.length){const [unreadRows,taskOwners]=await Promise.all([rows(s.from('messages').select('task_id,sender_id').in('task_id',bidderIds).eq('recipient_id',profile.id).is('read_at',null)),rows(s.from('tasks').select('id,user_id').in('id',bidderIds))]);const ownerByTask=new Map(taskOwners.map(t=>[Number(t.id),Number(t.user_id)]));unread=unreadRows.filter(m=>ownerByTask.get(Number(m.task_id))===Number(m.sender_id)).length;}return res.status(200).json(ok('',{pending_bids:pending,bidder_unread_messages:unread}));}
      if(action==='read_bids') {const bs=await rows(s.from('bids').select('id').eq('task_id',Number(query.get('task_id'))).eq('status','Pending'));if(bs.length)await rows(s.from('notification_reads').upsert(bs.map(b=>({user_id:profile.id,notification_type:'bid',reference_id:b.id})),{onConflict:'user_id,notification_type,reference_id',ignoreDuplicates:true}));return res.status(200).json(ok());}
      if(action==='task_messages') {const {count}=await s.from('messages').select('id',{count:'exact',head:true}).eq('task_id',Number(query.get('task_id'))).eq('recipient_id',profile.id).is('read_at',null);return res.status(200).json(ok('',{unread_count:count||0}));}
    }
    throw fail('Unknown action.',404);
  } catch (e) { const status=e.status||500; console.error(e); return res.status(status).json({success:false,message:status===500?'Something went wrong while processing your request.':e.message,...(status===401?{auth_required:true}:{} )}); }
}
