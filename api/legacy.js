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
  const [tasks, unreadMessages] = await Promise.all([
    rows(s.from('tasks').select('id,user_id,title,category,location,status,owner:user_profiles!tasks_user_id_fkey(first_name,last_name)').in('id', taskIds)),
    rows(s.from('messages').select('task_id,sender_id').in('task_id', taskIds).eq('recipient_id', profile.id).is('read_at', null))
  ]);
  const taskById = new Map(tasks.map((task) => [Number(task.id), task]));
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
      id: Number(bid.id), task_id: Number(bid.task_id), bidder_id: Number(bid.bidder_id),
      amount: Number(bid.amount), owner_id: Number(task?.user_id),
      owner_name: owner ? `${owner.first_name} ${owner.last_name}`.trim() : '',
      title: task?.title, category: task?.category, location: task?.location,
      task_status: task?.status,
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
  const [people, unreadMessages] = await Promise.all([
    rows(s.from('user_profiles').select('id,first_name,last_name').in('id', bidderIds)),
    rows(s.from('messages').select('sender_id').eq('task_id', task.id).eq('recipient_id', profile.id).in('sender_id', bidderIds).is('read_at', null)),
    reads.length ? rows(s.from('notification_reads').upsert(reads, { onConflict: 'user_id,notification_type,reference_id', ignoreDuplicates: true })) : Promise.resolve([])
  ]);
  const personById = new Map(people.map((person) => [Number(person.id), person]));
  const unreadByBidder = new Map();
  for (const message of unreadMessages) unreadByBidder.set(Number(message.sender_id), (unreadByBidder.get(Number(message.sender_id)) || 0) + 1);
  return visible.map((bid) => {
    const person = personById.get(Number(bid.bidder_id));
    return {
      ...bid, id: Number(bid.id), task_id: Number(bid.task_id), bidder_id: Number(bid.bidder_id),
      amount: Number(bid.amount), unread_message_count: unreadByBidder.get(Number(bid.bidder_id)) || 0,
      bidder_name: person ? `${person.first_name} ${person.last_name}`.trim() : 'TaskerPH member'
    };
  });
};
const shapeTasks = async (s, tasks, viewer, { mine = false } = {}) => {
  if (!tasks.length) return [];
  const taskIds = tasks.map((t) => t.id);
  if (mine) {
    const bids = await rows(s.from('bids').select('task_id,bidder_id').in('task_id', taskIds));
    const bidCounts = new Map();
    for (const bid of bids) bidCounts.set(Number(bid.task_id), (bidCounts.get(Number(bid.task_id)) || 0) + 1);
    return tasks.map((task) => ({
      ...task, id: Number(task.id), user_id: Number(task.user_id), budget: Number(task.budget),
      owner_name: `${viewer.first_name} ${viewer.last_name}`.trim(), has_bid: false,
      is_saved: false, bid_count: bidCounts.get(Number(task.id)) || 0, unread_message_count: 0
    }));
  }
  const ownerIds = [...new Set(tasks.map((t) => t.user_id))];
  const [owners, bids, saves, messages] = await Promise.all([
    rows(s.from('user_profiles').select('id,first_name,last_name').in('id', ownerIds)),
    rows(s.from('bids').select('task_id,bidder_id').in('task_id', taskIds)),
    viewer ? rows(s.from('saved_tasks').select('task_id').eq('user_id', viewer.id).in('task_id', taskIds)) : Promise.resolve([]),
    viewer ? rows(s.from('messages').select('task_id').eq('recipient_id', viewer.id).is('read_at', null).in('task_id', taskIds)) : Promise.resolve([])
  ]);
  const ownerById = new Map(owners.map((p) => [Number(p.id), p]));
  const bidsByTask = new Map();
  for (const bid of bids) {
    const item = bidsByTask.get(Number(bid.task_id)) || { count: 0, hasBid: false };
    item.count += 1;
    if (viewer && Number(bid.bidder_id) === Number(viewer.id)) item.hasBid = true;
    bidsByTask.set(Number(bid.task_id), item);
  }
  const savedIds = new Set(saves.map((r) => Number(r.task_id)));
  const unreadByTask = new Map();
  for (const message of messages) unreadByTask.set(Number(message.task_id), (unreadByTask.get(Number(message.task_id)) || 0) + 1);
  return tasks.map((task) => {
    const owner = ownerById.get(Number(task.user_id));
    const bidData = bidsByTask.get(Number(task.id));
    return { ...task, id: Number(task.id), user_id: Number(task.user_id), budget: Number(task.budget), owner_name: owner ? `${owner.first_name} ${owner.last_name}`.trim() : 'TaskerPH member', has_bid: Boolean(bidData?.hasBid), is_saved: savedIds.has(Number(task.id)), bid_count: bidData?.count || 0, unread_message_count: unreadByTask.get(Number(task.id)) || 0 };
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
      if (['Open','In Progress','Completed'].includes(query.get('status'))) q = q.eq('status', query.get('status'));
      if (query.get('category')) q = q.eq('category', query.get('category'));
      if (query.get('search')) { const term = query.get('search').replace(/[,%()]/g, ' '); q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%,location.ilike.%${term}%`); }
      const tasks = await rows(q); return res.status(200).json(ok('', { tasks: await shapeTasks(s, tasks, profile, { mine: query.get('mine') === '1' }) }));
    }
    if (route === 'create_task') {
      ({ profile } = await userFor(req, s, true));
      const item = { user_id: profile.id, title: clean(body.title,180), category: clean(body.category,80), budget: Number(body.budget), location: clean(body.location,160), description: clean(body.description,2000) };
      if (!item.title || !item.category || !item.location || !item.description || !Number.isFinite(item.budget) || item.budget < 0) throw fail('Complete every field with valid values.',422);
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
        const [listingResult, totalResult, completedResult] = await Promise.all([
          s.from('tasks').select('id,user_id,title,category,budget,location,description,status,created_at,image_urls').eq('user_id', publicId).order('created_at', { ascending: false }).limit(12),
          s.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', publicId),
          s.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', publicId).eq('status', 'Completed')
        ]);
        if (listingResult.error || totalResult.error || completedResult.error) throw fail((listingResult.error || totalResult.error || completedResult.error).message, 500);
        return res.status(200).json(ok('', { profile: { id: Number(publicProfile.id), first_name: publicProfile.first_name, middle_initial: publicProfile.middle_initial || '', last_name: publicProfile.last_name, avatar_path: publicProfile.avatar_path || null, created_at: publicProfile.created_at }, tasks: (listingResult.data || []).map((task) => ({ ...task, id: Number(task.id), user_id: Number(task.user_id), budget: Number(task.budget) })), total_tasks: totalResult.count || 0, completed_tasks: completedResult.count || 0 }));
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
      if (action === 'activity_dashboard') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view account activity.',403);
        const [accounts, events, reports, tasks, totalTasks, completedTasks, openTasks] = await Promise.all([
          rows(s.from('user_profiles').select('id,first_name,middle_initial,last_name,email,role,created_at').order('role').order('first_name')),
          rows(s.from('account_activity').select('id,event_type,summary,reference_type,reference_id,created_at,user:user_profiles!account_activity_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).limit(40)),
          rows(s.from('task_reports').select('id,task_id,reason,details,status,created_at,task:tasks!task_reports_task_id_fkey(title),reporter:user_profiles!task_reports_reporter_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).limit(30)),
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(50)),
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
        return res.status(200).json(ok('',{users,events,reports,tasks:taskItems,has_more_tasks:tasks.length < (totalTasks.count||0),stats:{total_tasks:totalTasks.count||0,completed_tasks:completedTasks.count||0,open_tasks:openTasks.count||0}}));
      }
      if (action === 'more_tasks') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can load platform tasks.',403);
        const offset = Number(body.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fail('Choose a valid task page.',422);
        const rowsFound = await rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,owner:user_profiles!tasks_user_id_fkey(first_name,last_name,email)').order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+50));
        const hasMore = rowsFound.length > 50;
        const taskItems = rowsFound.slice(0,50).map((task)=>({...task,id:Number(task.id),user_id:Number(task.user_id),budget:Number(task.budget)||0,owner_name:task.owner?`${task.owner.first_name} ${task.owner.last_name}`.trim():'TaskerPH member'}));
        return res.status(200).json(ok('',{tasks:taskItems,has_more_tasks:hasMore}));
      }
      if (action === 'view_task_details') {
        if (profile.role !== 'superadmin') throw fail('Only the Superadmin can view task moderation details.',403);
        const taskId = Number(body.task_id);
        if (!Number.isSafeInteger(taskId) || taskId < 1) throw fail('Choose a valid task.',422);
        const [task, bids, totalBids, acceptedBids, pendingBids, rejectedBids] = await Promise.all([
          rows(s.from('tasks').select('id,user_id,title,category,status,budget,location,description,image_urls,created_at,owner:user_profiles!tasks_user_id_fkey(id,first_name,middle_initial,last_name,email,avatar_path,role,created_at)').eq('id',taskId).maybeSingle()),
          rows(s.from('bids').select('id,task_id,bidder_id,amount,status,message,created_at,removal_reason,bidder:user_profiles!bids_bidder_id_fkey(id,first_name,middle_initial,last_name,email,avatar_path,role,created_at)').eq('task_id',taskId).order('created_at',{ascending:false}).limit(200)),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId).eq('status','Accepted'),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId).eq('status','Pending'),
          s.from('bids').select('id',{count:'exact',head:true}).eq('task_id',taskId).eq('status','Rejected')
        ]);
        if (!task) throw fail('Task not found.',404);
        for (const result of [totalBids,acceptedBids,pendingBids,rejectedBids]) if(result.error) throw fail(result.error.message);
        const taskData = {...task,id:Number(task.id),user_id:Number(task.user_id),budget:Number(task.budget)||0,owner_name:task.owner?`${task.owner.first_name} ${task.owner.last_name}`.trim():'TaskerPH member'};
        const bidItems = bids.map((bid)=>({...bid,id:Number(bid.id),task_id:Number(bid.task_id),bidder_id:Number(bid.bidder_id),amount:Number(bid.amount)||0,bidder:bid.bidder?{...bid.bidder,id:Number(bid.bidder.id)}:null}));
        return res.status(200).json(ok('',{task:taskData,bids:bidItems,stats:{total_bids:totalBids.count||0,accepted_bids:acceptedBids.count||0,pending_bids:pendingBids.count||0,rejected_bids:rejectedBids.count||0}}));
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
        const [report]=await rows(s.from('task_reports').insert({task_id:taskId,reporter_id:profile.id,reason,details}).select('id'));
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
      const id=Number(body.task_id); const taskColumns=['update_task','delete_task'].includes(action)?'user_id,image_urls,status':'user_id'; const t=await rows(s.from('tasks').select(taskColumns).eq('id',id).maybeSingle());
      if(!t || (!isMod(profile)&&Number(t.user_id)!==Number(profile.id))) throw fail('You can only manage your own task postings.',403);
      if(action==='delete_task') {
        await rows(s.from('tasks').delete().eq('id',id));
        const bucketPrefix=`${url.replace(/\/$/,'')}/storage/v1/object/public/task-photos/`;
        const photoPaths=(Array.isArray(t.image_urls)?t.image_urls:[]).filter((photoUrl)=>photoUrl.startsWith(bucketPrefix)).map((photoUrl)=>decodeURIComponent(photoUrl.slice(bucketPrefix.length).split('?')[0]));
        if(photoPaths.length) await s.storage.from('task-photos').remove(photoPaths).catch(()=>{});

        return res.status(200).json(ok('Task removed from the marketplace.'));
      }
      if(action==='update_task') {
        const patch={title:clean(body.title,180),category:clean(body.category,80),budget:Number(body.budget),location:clean(body.location,160),description:clean(body.description,2000),status:body.status};
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
      if(action==='list') { const bids=await loadTaskBids(s,task,profile); return res.status(200).json(ok('',{bids})); }
      if(action==='place') { if(Number(task.user_id)===Number(profile.id)) throw fail('You cannot bid on your own task.',403); if(task.status!=='Open') throw fail('This task is no longer accepting bids.',409); const accepted=await rows(s.from('bids').select('id').eq('bidder_id',profile.id).eq('status','Accepted').maybeSingle()); if(accepted) throw fail('You already have an accepted bid. Complete that task before bidding on another task.',409); const amount=Number(body.amount),message=clean(body.message,1000);if(!Number.isFinite(amount)||amount<0||!message)throw fail('Enter a valid offer and message.',422); await rows(s.from('bids').upsert({task_id:taskId,bidder_id:profile.id,amount,message,status:'Pending'},{onConflict:'task_id,bidder_id'}));  return res.status(200).json(ok('Your bid has been submitted.')); }
      const bidId=Number(body.bid_id);
      if(action==='update') {const amount=Number(body.amount),message=clean(body.message,1000);if(!Number.isFinite(amount)||amount<0||!message||task.status!=='Open')throw fail('Enter a valid offer and message.',422);const updated=await rows(s.from('bids').update({amount,message}).eq('id',bidId).eq('task_id',taskId).eq('bidder_id',profile.id).eq('status','Pending').select('id'));if(!updated.length)throw fail('Only your pending bid on an open task can be edited.',403);return res.status(200).json(ok('Your bid was updated.')); }
      if(action==='delete') {const bid=await rows(s.from('bids').select('id').eq('id',bidId).eq('task_id',taskId).eq('bidder_id',profile.id).eq('status','Pending').maybeSingle());if(!bid||task.status!=='Open')throw fail('Only your pending bid on an open task can be deleted.',403);await rows(s.from('messages').delete().eq('task_id',taskId).or(`sender_id.eq.${profile.id},recipient_id.eq.${profile.id}`));await rows(s.from('bids').delete().eq('id',bidId).eq('task_id',taskId).eq('bidder_id',profile.id));return res.status(200).json(ok('Your bid was deleted.')); }
      if(action==='accept') { if(Number(task.user_id)!==Number(profile.id)&&!isMod(profile)) throw fail('Only the task owner or a moderator can accept a bid.',403);const target=await rows(s.from('bids').select('id').eq('id',bidId).eq('task_id',taskId).maybeSingle());if(!target)throw fail('Bid not found for this task.',404); await rows(s.from('bids').update({status:'Rejected'}).eq('task_id',taskId));await rows(s.from('bids').update({status:'Accepted'}).eq('task_id',taskId).eq('id',bidId));await rows(s.from('tasks').update({status:'In Progress'}).eq('id',taskId));return res.status(200).json(ok('Bid accepted. The task is now in progress.')); }
      if(action==='remove_bid') {if(Number(task.user_id)!==Number(profile.id)&&!isMod(profile)) throw fail('Only the task owner or a moderator can remove a bidder.',403);const reason=clean(body.reason,1000);if(!reason)throw fail('Please provide a reason for removing the bidder.',422);const removed=await rows(s.from('bids').update({status:'Pending',removal_reason:reason}).eq('id',bidId).eq('task_id',taskId).in('status',['Pending','Accepted']).select('id'));if(!removed.length)throw fail('Only pending or accepted bidders can be removed.',409);return res.status(200).json(ok('The bidder was removed and the reason was saved.'));}
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
      ({ profile } = await userFor(req,s, action !== 'counts' && action !== 'task_messages'));
      if(action==='counts') {const tasks=await rows(s.from('tasks').select('id').eq('user_id',profile.id));const ownedIds=tasks.map(x=>x.id);const bidderLinks=await rows(s.from('bids').select('task_id').eq('bidder_id',profile.id));const bidderIds=[...new Set(bidderLinks.map(x=>x.task_id))];let pending=0,unread=0;if(ownedIds.length){const bs=await rows(s.from('bids').select('id,task_id').in('task_id',ownedIds).eq('status','Pending'));const reads=await rows(s.from('notification_reads').select('reference_id').eq('user_id',profile.id));const seen=new Set(reads.map(x=>x.reference_id));pending=bs.filter(x=>!seen.has(x.id)).length;}if(bidderIds.length){const [unreadRows,taskOwners]=await Promise.all([rows(s.from('messages').select('task_id,sender_id').in('task_id',bidderIds).eq('recipient_id',profile.id).is('read_at',null)),rows(s.from('tasks').select('id,user_id').in('id',bidderIds))]);const ownerByTask=new Map(taskOwners.map(t=>[Number(t.id),Number(t.user_id)]));unread=unreadRows.filter(m=>ownerByTask.get(Number(m.task_id))===Number(m.sender_id)).length;}return res.status(200).json(ok('',{pending_bids:pending,bidder_unread_messages:unread}));}
      if(action==='read_bids') {const bs=await rows(s.from('bids').select('id').eq('task_id',Number(query.get('task_id'))).eq('status','Pending'));if(bs.length)await rows(s.from('notification_reads').upsert(bs.map(b=>({user_id:profile.id,notification_type:'bid',reference_id:b.id})),{onConflict:'user_id,notification_type,reference_id',ignoreDuplicates:true}));return res.status(200).json(ok());}
      if(action==='task_messages') {const {count}=await s.from('messages').select('id',{count:'exact',head:true}).eq('task_id',Number(query.get('task_id'))).eq('recipient_id',profile.id).is('read_at',null);return res.status(200).json(ok('',{unread_count:count||0}));}
    }
    throw fail('Unknown action.',404);
  } catch (e) { const status=e.status||500; console.error(e); return res.status(status).json({success:false,message:status===500?'Something went wrong while processing your request.':e.message,...(status===401?{auth_required:true}:{} )}); }
}
