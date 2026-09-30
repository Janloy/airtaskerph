import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

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
const publicUser = (p) => ({ id: Number(p.id), first_name: p.first_name, middle_initial: p.middle_initial || '', last_name: p.last_name, email: p.email, role: p.role, avatar_path: p.avatar_path || null });
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
const touchPresence = async (s, userId, isLogin = false) => {
  const { error } = await s.rpc('touch_account_presence', { p_user_id: userId, p_is_login: isLogin });
  if (error) console.error('Account presence update failed:', error.message);
};
const logActivity = async (s, userId, eventType, summary, referenceType = null, referenceId = null) => {
  const { error } = await s.from('account_activity').insert({ user_id: userId, event_type: eventType, summary: clean(summary, 180), reference_type: referenceType, reference_id: referenceId == null ? null : String(referenceId) });
  if (error) console.error('Account activity log failed:', error.message);
};
const taskNotice = async (s, userId, taskId, eventType, title, message, dedupeKey) => {
  if (!userId || !taskId) return;
  const { error } = await s.from('task_notifications').upsert({ user_id:userId, task_id:taskId, event_type:eventType, title:clean(title,120), body:clean(message,500), dedupe_key:dedupeKey }, { onConflict:'dedupe_key', ignoreDuplicates:true });
  if (error) throw fail(error.message,400);
};
const rows = async (q) => { const { data, error } = await q; if (error) throw fail(error.message, error.code === '23505' ? 409 : 400); return data; };
const userFor = async (req, s, trackActivity = false) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw fail('Please log in to continue.', 401);
  const { data, error } = await s.auth.getUser(token);
  if (error || !data.user) throw fail('Your session has ended. Please log in again.', 401);
  const profile = await getProfile(s, data.user.id);
  if (trackActivity) await touchPresence(s, profile.id);
  return { auth: data.user, profile, token };
};
const isMod = (u) => ['admin', 'superadmin'].includes(u.role);
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
      if (action === 'has_reported') {
        const taskId = Number(body.task_id);
        if (!Number.isSafeInteger(taskId) || taskId < 1) throw fail('Invalid task.', 422);
        const priorReport = await rows(s.from('task_reports').select('id').eq('task_id', taskId).eq('reporter_id', profile.id).maybeSingle());
        return res.status(200).json(ok('', { has_reported: Boolean(priorReport) }));
      }
      if (action === 'activity_dashboard') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view account activity.',403);
        const [accounts, events, reports, tasks, underReviewTasks, totalTasks, completedTasks, openTasks] = await Promise.all([
          rows(s.from('user_profiles').select('id,first_name,middle_initial,last_name,email,role,created_at').order('role').order('first_name')),
          rows(s.from('account_activity').select('id,event_type,summary,reference_type,reference_id,created_at,user:user_profiles!account_activity_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).limit(40)),
          rows(s.from('task_reports').select('id,task_id,reporter_id,reason,details,status,created_at,task:tasks!task_reports_task_id_fkey(id,user_id,title,description,category,status,budget,location,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)),reporter:user_profiles!task_reports_reporter_id_fkey(id,first_name,last_name,email)').order('created_at',{ascending:false}).limit(1000)),
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(50)),
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)').eq('status','Under Review').order('created_at',{ascending:false}).limit(200)),
          s.from('tasks').select('id',{count:'exact',head:true}),
          s.from('tasks').select('id',{count:'exact',head:true}).eq('status','Completed'),
          s.from('tasks').select('id',{count:'exact',head:true}).eq('status','Open')
        ]);
        for (const result of [totalTasks,completedTasks,openTasks]) if (result.error) throw fail(result.error.message);
        const ids = accounts.map((account) => account.id);
        const presence = ids.length ? await rows(s.from('account_presence').select('user_id,last_login_at,last_seen_at').in('user_id',ids)) : [];
        const presenceByUser = new Map(presence.map((item) => [Number(item.user_id), item]));
        const users = accounts.map((account) => ({
          id: Number(account.id), first_name: account.first_name, middle_initial: account.middle_initial || '',
          last_name: account.last_name, email: account.email, role: account.role, created_at: account.created_at,
          ...(presenceByUser.get(Number(account.id)) || { last_login_at: null, last_seen_at: null })
        }));
        const taskItems = tasks.map((task) => ({ ...task, id:Number(task.id), user_id:Number(task.user_id), budget:Number(task.budget)||0, owner_name:task.owner ? `${task.owner.first_name} ${task.owner.last_name}`.trim() : 'TaskerPH member' }));
        const reviewTaskItems = underReviewTasks.map((task) => ({ ...task, id:Number(task.id), user_id:Number(task.user_id), budget:Number(task.budget)||0, owner_name:task.owner ? `${task.owner.first_name} ${task.owner.last_name}`.trim() : 'TaskerPH member' }));
        return res.status(200).json(ok('',{users,events,reports,tasks:taskItems,under_review_tasks:reviewTaskItems,has_more_tasks:tasks.length < (totalTasks.count||0),stats:{total_tasks:totalTasks.count||0,completed_tasks:completedTasks.count||0,open_tasks:openTasks.count||0}}));
      }
      if (action === 'more_tasks') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can load platform tasks.',403);
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
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view task moderation details.',403);
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
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view member profiles.',403);
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
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can review reports.',403);
        const id=Number(body.report_id), status=body.status;
        if (!Number.isSafeInteger(id) || !['Reviewed','Dismissed'].includes(status)) throw fail('Choose a valid report status.',422);
        await rows(s.from('task_reports').update({status}).eq('id',id));
        await logActivity(s,profile.id,'report_reviewed',`Report #${id} marked ${status.toLowerCase()}`,'report',id);
        return res.status(200).json(ok('Report updated.'));
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
        if (!['user','admin'].includes(role)) throw fail('Choose either User or Admin as the role.',422);
        if (email !== String(target.email).toLowerCase()) {
          const { error } = await s.auth.admin.updateUserById(target.auth_user_id,{email,email_confirm:true});
          if (error) throw fail(error.message,400);
        }
        const [updated] = await rows(s.from('user_profiles').update({first_name,middle_initial,last_name,email,role}).eq('id',targetId).select('id,first_name,middle_initial,last_name,email,role,created_at').limit(1));
        if (!updated) throw fail('The account could not be updated.',500);
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
        const {error}=await s.auth.admin.deleteUser(target.auth_user_id);
        if(error) throw fail(error.message,400);
        await logActivity(s,profile.id,'user_deleted',`Deleted account: ${target.first_name} ${target.last_name} (${target.role})`,'user',target.id);
        return res.status(200).json(ok('User account deleted.'));
      }
      if (action==='create_admin') {
        if(profile.role!=='superadmin') throw fail('Only the Superadmin can create Admin accounts.',403);
        const {data,error}=await s.auth.admin.createUser({email:clean(body.email,190).toLowerCase(),password:String(body.password||''),email_confirm:true,user_metadata:{first_name:clean(body.first_name,80),middle_initial:clean(body.middle_initial,1),last_name:clean(body.last_name,80)}});
        if(error) throw fail(error.message,400); await rows(s.from('user_profiles').update({role:'admin'}).eq('auth_user_id',data.user.id)); return res.status(200).json(ok('Admin account provisioned.'));
      }
      const id=Number(body.task_id); const taskColumns=['update_task','delete_task','reopen_task'].includes(action)?'user_id,image_urls,status':'user_id'; const t=await rows(s.from('tasks').select(taskColumns).eq('id',id).maybeSingle());
      if(!t || (!isMod(profile)&&Number(t.user_id)!==Number(profile.id))) throw fail('You can only manage your own task postings.',403);
      if(action==='delete_task') {
        if(t.status==='Completed'&&!isMod(profile)) throw fail('Completed tasks cannot be deleted by their owner.',409);
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
        if(profile.role!=='superadmin') throw fail('Only the Superadmin can resolve a task dispute.',403);
        const resolutionStatus=body.status;
        if(!['In Progress','Completed','Cancelled'].includes(resolutionStatus)) throw fail('Choose a valid dispute resolution.',422);
        if(task.status!=='Under Review') throw fail('This task is not under review.',409);
        const resolution=clean(body.resolution,1000)||`Superadmin set task status to ${resolutionStatus}.`, now=new Date().toISOString();
        const resolvedTask=await rows(s.from('tasks').update({status:resolutionStatus,...(resolutionStatus==='Completed'?{completion_confirmed_at:now}:{})}).eq('id',taskId).eq('status','Under Review').select('id'));
        if(!resolvedTask.length) throw fail('The task status changed. Refresh and review the dispute again.',409);
        await rows(s.from('task_disputes').update({status:'Resolved',resolution,resolved_by:profile.id,resolved_at:now}).eq('task_id',taskId).eq('status','Open'));
        if(resolutionStatus==='Cancelled') await rows(s.from('bids').update({status:'Cancelled'}).eq('task_id',taskId).eq('id',acceptedBid.id));
        for(const recipient of [posterId,taskerId]) await taskNotice(s,recipient,taskId,'dispute_resolved','Task issue reviewed',`The Superadmin reviewed “${task.title}”. Resolution: ${resolutionStatus}.`,`task:${taskId}:dispute-resolved:${recipient}:${randomUUID()}`);
        await logActivity(s,profile.id,'task_dispute_resolved',`Task dispute resolved: ${task.title} (${resolutionStatus})`,'task',taskId);
        return res.status(200).json(ok('Task dispute resolved.'));
      }
    }
    if (route === 'messages') {
      ({ profile } = await userFor(req,s, action !== 'list')); const taskId=Number(body.task_id||query.get('task_id')), other=Number(body.other_user_id||query.get('other_user_id'));
      const t=await rows(s.from('tasks').select('user_id,bids(bidder_id)').eq('id',taskId).maybeSingle());
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
      if(action==='send') {const text=clean(body.body,2000);if(!text)throw fail('Message cannot be empty.',422);const [message]=await rows(s.from('messages').insert({task_id:taskId,sender_id:profile.id,recipient_id:other,body:text}).select('*'));return res.status(200).json(ok('Message sent.',{message}));}
    }
    if (route === 'notifications') {
      ({ profile } = await userFor(req,s, action !== 'counts' && action !== 'task_messages' && action !== 'task_updates' && action !== 'center'));
      if(action==='center') {
        const [taskNotices,messageRows,ownedTasks]=await Promise.all([
          rows(s.from('task_notifications').select('id,task_id,event_type,title,body,dedupe_key,is_read,created_at').eq('user_id',profile.id).order('created_at',{ascending:false}).limit(50)),
          rows(s.from('messages').select('id,task_id,sender_id,body,read_at,created_at').eq('recipient_id',profile.id).order('created_at',{ascending:false}).limit(50)),
          rows(s.from('tasks').select('id,title').eq('user_id',profile.id))
        ]);
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
          })
        ].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,100);
        const unreadCount=taskNotices.filter((item)=>!item.is_read).length+(unreadMessageCount.count||0)+pendingBids.filter((item)=>!notifiedBidIds.has(Number(item.id))&&!seenBidIds.has(Number(item.id))).length;
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
        return res.status(200).json(ok('All notifications marked as read.'));
      }
      if(action==='read_item' && body.type==='task') {
        await rows(s.from('task_notifications').update({is_read:true}).eq('id',Number(body.id)).eq('user_id',profile.id));
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
