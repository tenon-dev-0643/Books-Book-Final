(() => {
  'use strict';
  const conf = window.BOOKSBOOK_CONFIG || {};
  const screen = document.getElementById('authScreen');
  const notice = document.getElementById('authNotice');
  const form = document.getElementById('authForm');
  const app = document.getElementById('protectedApp');
  const cloudStatus = document.getElementById('cloudStatus');
  let client = null, user = null, boot = null, timer = null, pending = null, inFlight = false;
  let revision = 0, savedRevision = 0, isStarting = true;
  let base = null; /* 起動時に読み込んだクラウドデータ（3方向マージの基準） */
  const text = (s) => { notice.textContent = s; };
  const status = (s) => { cloudStatus.textContent = s; };
  const errorText = (e) => e?.message || '通信に失敗しました。接続を確認してください。';
  function setLoginVisible() { app.hidden = true; screen.hidden = false; form.hidden = false; }
  function setLoading() { screen.hidden = false; app.hidden = true; form.hidden = true; text('読み込み中…'); }
  async function retrieve() {
    const { data, error } = await client.from('user_libraries').select('library').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data?.library || null;
  }
  async function enter() {
    setLoading();
    try {
      const data = await retrieve();
      if (!user) return;
      base = data ? structuredClone(data) : null;
      // データはクラウド側が正。旧バージョンのローカルデータは明示的な同意後にのみ移行。
      pending = null; revision = savedRevision = 0; isStarting = true;
      boot(data);
      isStarting = false;
      screen.hidden = true; app.hidden = false;
      document.getElementById('authUserEmail').textContent = user.email || '';
      status('同期済み');
      const legacy = localStorage.getItem('manga-release-watch.v1');
      if (legacy && !data?.titles?.length && !data?.releases?.length) {
        if (confirm('以前このブラウザに保存した漫画データがあります。クラウドに取り込みますか？')) {
          try {
            const old = JSON.parse(legacy);
            if (Array.isArray(old.titles) && Array.isArray(old.releases)) {
              boot(old);
              // 旧データは保存成功後もバックアップ用に残す
              queueSave({ titles: old.titles, releases: old.releases, noticeDays: old.noticeDays || 3 });
            }
          } catch { status('旧データを読み取れませんでした'); }
        }
      }
    } catch (e) {
      setLoginVisible(); text('データ取得に失敗: ' + errorText(e) + '（設定とRLSをご確認ください）');
    }
  }
  async function signOut() {
    if (timer) clearTimeout(timer);
    if (pending || inFlight) {
      await flush();
      if (pending || inFlight) { status('未保存の変更があります'); return; }
    }
    const {error} = await client.auth.signOut();
    if (error) { status(errorText(error)); return; }
    location.reload();
  }
  /* 3方向マージ: 基準（起動時の読み込み）・最新のクラウド・この端末の保存内容を突き合わせ、
     他端末の追加を消さない・この端末の削除/編集は反映する・他端末の削除も尊重する */
  function mergeList(baseArr, cloudArr, localArr) {
    const baseIds = new Set((baseArr || []).map((x) => x.id));
    const cloudIds = new Set((cloudArr || []).map((x) => x.id));
    const localIds = new Set((localArr || []).map((x) => x.id));
    const byId = new Map();
    for (const item of cloudArr || []) {
      if (baseIds.has(item.id) && !localIds.has(item.id)) continue; /* この端末で削除済み */
      byId.set(item.id, item);
    }
    for (const item of localArr || []) {
      if (baseIds.has(item.id) && !cloudIds.has(item.id)) continue; /* 他端末で削除済み */
      byId.set(item.id, item); /* この端末の内容が正 */
    }
    return [...byId.values()];
  }
  function mergeLibraries(baseLib, cloudLib, localLib) {
    if (!cloudLib || !baseLib) return localLib;
    return {
      titles: mergeList(baseLib.titles, cloudLib.titles, localLib.titles),
      releases: mergeList(baseLib.releases, cloudLib.releases, localLib.releases),
      noticeDays: localLib.noticeDays ?? cloudLib.noticeDays ?? 3,
    };
  }
  async function flush() {
    if (!user || isStarting || inFlight || !pending) return;
    inFlight = true;
    const item = pending;
    const writingRevision = revision;
    pending = null;
    status('保存中…');
    let toWrite = item;
    try {
      const latest = await retrieve();
      toWrite = mergeLibraries(base, latest, item);
    } catch { /* 最新取得に失敗したら従来通りこの端末の内容で保存 */ }
    const { error } = await client.from('user_libraries').upsert({ user_id: user.id, library: toWrite, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    inFlight = false;
    if (error) {
      pending = pending || item;
      status('保存失敗 — 再試行してください');
      console.error('Cloud save error:', error);
    } else {
      savedRevision = writingRevision;
      base = structuredClone(toWrite);
      status('同期済み');
      if (JSON.stringify(toWrite) !== JSON.stringify(item)) {
        try { boot(toWrite); status('他の端末の変更を取り込みました'); } catch {}
      }
    }
    if (pending && !error) schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  }
  function queueSave(item) {
    if (!user || isStarting) return;
    revision++;
    pending = structuredClone(item);
    status('未同期の変更あり');
    schedule();
  }
  /* 手動更新: 未保存分を送ってから最新を取得し、3方向マージして再描画する */
  async function refresh(getLocal) {
    if (!user) return 'noauth';
    if (inFlight || isStarting) return 'busy';
    try {
      if (pending) await flush();
      const latest = await retrieve();
      if (!latest) { status('同期済み'); return 'ok'; }
      const local = typeof getLocal === 'function' ? getLocal() : null;
      const merged = local ? mergeLibraries(base, latest, local) : latest;
      base = structuredClone(merged);
      boot(merged);
      if (JSON.stringify(merged) !== JSON.stringify(latest)) queueSave(merged);
      status('同期済み');
      return 'ok';
    } catch (e) {
      status('更新に失敗しました');
      return 'error';
    }
  }
  async function start(onBoot) {
    boot = onBoot;
    if (!conf.supabaseUrl || !conf.supabasePublishableKey || !window.supabase) {
      text('管理者設定が必要です。config.js の Supabase URL・公開用キーを設定してください。');
      return;
    }
    try {
      client = window.supabase.createClient(conf.supabaseUrl, conf.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const {data, error} = await client.auth.getUser();
      if (error && error.name !== 'AuthSessionMissingError') console.warn(error);
      user = data?.user || null;
      if (user) await enter();
      else { text('ログインしてください。'); setLoginVisible(); }
    } catch (e) { text('認証初期化エラー: ' + errorText(e)); }
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!client) return;
    text('ログイン中…');
    const { data, error } = await client.auth.signInWithPassword({email: document.getElementById('authEmail').value.trim(), password: document.getElementById('authPassword').value});
    if (error) { text('ログインできません: ' + errorText(error)); return; }
    user = data.user; await enter();
  });
  document.getElementById('authRegister').addEventListener('click', async () => {
    if (!client) return;
    if (!form.reportValidity()) return;
    text('登録中…');
    const {data, error} = await client.auth.signUp({email: document.getElementById('authEmail').value.trim(), password: document.getElementById('authPassword').value, options: { emailRedirectTo: location.origin + location.pathname }});
    if (error) { text('登録できません: ' + errorText(error)); return; }
    if (data.session && data.user) { user = data.user; await enter(); }
    else text('登録手続きを受け付けました。メール認証を有効にしている場合は、届いたメール内のリンクを開いてからログインしてください。');
  });
  document.getElementById('authLogout').addEventListener('click', signOut);
  window.addEventListener('online', () => { if (pending) schedule(); });
  window.BooksAuth = { start, queueSave, refresh };
})();
