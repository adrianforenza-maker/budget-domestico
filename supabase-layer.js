// ══════════════════════════════════════════════════════════════
//  supabase-layer.js — Budget Domestico
//  Sostituisce: window.budgetAPI (Electron) + Google Drive sync
//  Usato da: index.html (desktop) e budget-mobile.html (PWA)
//
//  Dipendenza: Supabase JS SDK (CDN)
//  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://rsguruupqwmqjhdqgill.supabase.co';
const SUPABASE_KEY = 'sb_publishable_CSa8Fnt4KQfG5v12j5QCxw_XLoTve5j';

const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: localStorage
  }
});

// ── Auth helpers ────────────────────────────────────────────────

async function sbSignIn(email, password) {
  const { data, error } = await _sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

async function sbSignOut() {
  await _sb.auth.signOut();
}

async function sbCurrentUser() {
  const { data: { user } } = await _sb.auth.getUser();
  return user;
}

async function sbIsLoggedIn() {
  const user = await sbCurrentUser();
  return !!user;
}

// ── Fetch tutti i record con paginazione (supera limite 1000) ────
async function _fetchAll(table, orderCol, ascending = false) {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await _sb
      .from(table)
      .select('*')
      .order(orderCol, { ascending })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── Normalizzazione dati Supabase → formato interno app ─────────
// Interno desktop:  { ID, MdbID, Data, Descrizione, Importo, IDCategoria, Categoria, Note }
// Interno mobile:   { id, tipo, data, desc, importo, idCat, note }
// Supabase:         { id, data, descrizione, importo, categoria, note, user_id }

const COLORS = ['#4f8ef7','#7c5cf6','#f0566a','#f5a124','#22d4e0','#e855ec','#1ecf96',
                '#fb923c','#9aa3c2','#a3e635','#f43f5e','#06b6d4','#84cc16','#f97316',
                '#8b5cf6','#ec4899','#14b8a6','#eab308','#6366f1','#10b981'];
const COLORS_EN = ['#1ecf96','#4f8ef7','#7c5cf6','#f5a124','#22d4e0','#e855ec','#f0566a'];

function _normCats(rows, colors) {
  return (rows || []).map((r, i) => ({
    ID:     r.id,
    Nome:   r.nome,
    Colore: r.colore || colors[i % colors.length]
  }));
}

function _normSpese(rows, cats) {
  const catMap = {};
  (cats || []).forEach(c => { catMap[c.Nome?.toLowerCase()] = c.ID; });
  return (rows || []).map((r, i) => ({
    ID:          i + 1,
    MdbID:       r.id,          // id Supabase usato come MdbID
    Data:        r.data,
    Descrizione: r.descrizione || '',
    Importo:     parseFloat(r.importo) || 0,
    IDCategoria: catMap[r.categoria?.toLowerCase()] || 1,
    Categoria:   r.categoria || '',
    Note:        r.note || ''
  }));
}

function _normEntrate(rows, cats) {
  const catMap = {};
  (cats || []).forEach(c => { catMap[c.Nome?.toLowerCase()] = c.ID; });
  return (rows || []).map((r, i) => ({
    ID:          i + 1,
    MdbID:       r.id,
    Data:        r.data,
    Descrizione: r.descrizione || '',
    Importo:     parseFloat(r.importo) || 0,
    IDCategoria: catMap[r.categoria?.toLowerCase()] || 1,
    Categoria:   r.categoria || '',
    Note:        r.note || ''
  }));
}

// ── API pubblica — drop-in replacement di window.budgetAPI ──────

window.budgetAPI = {

  // ── Stato connessione ─────────────────────────────────────────
  getStatus: async () => {
    const user = await sbCurrentUser();
    return { mdbPath: null, connected: !!user, supabase: true, userEmail: user?.email };
  },

  getDataPath: async () => ({ local: 'Supabase Cloud', mdb: null }),

  // ── Carica tutti i dati ────────────────────────────────────────
  loadData: async () => {
    try {
      const user = await sbCurrentUser();
      if (!user) return { success: false, error: 'not_authenticated', needsLogin: true };

      const [rCats, rCatsEn, speseData, entrateData] = await Promise.all([
        _sb.from('categorie').select('*').order('nome'),
        _sb.from('categorie_entrate').select('*').order('nome'),
        _fetchAll('spese', 'data', false),
        _fetchAll('entrate', 'data', false)
      ]);

      if (rCats.error)    throw rCats.error;
      if (rCatsEn.error)  throw rCatsEn.error;

      const rSpese   = { data: speseData };
      const rEntrate = { data: entrateData };

      const categorie        = _normCats(rCats.data,   COLORS);
      const categorieEntrate = _normCats(rCatsEn.data, COLORS_EN);
      const dati             = _normSpese(rSpese.data,   categorie);
      const datiEntrate      = _normEntrate(rEntrate.data, categorieEntrate);

      return {
        success: true,
        source: 'supabase',
        data: { dati, datiEntrate, categorie, categorieEntrate,
                nextDatiId: dati.length + 1, nextEntrateId: datiEntrate.length + 1 }
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Salva spesa ───────────────────────────────────────────────
  saveSpesa: async (record) => {
    try {
      const user = await sbCurrentUser();
      if (!user) return { success: false, error: 'not_authenticated' };

      // Risolvi nome categoria: usa Categoria se presente, altrimenti cerca per IDCategoria
      let catNome = record.Categoria || '';
      if (!catNome && record.IDCategoria) {
        const cat = (DB.categorie || []).find(c => c.ID == record.IDCategoria);
        catNome = cat ? cat.Nome : '';
      }

      const row = {
        data:        record.Data,
        descrizione: record.Descrizione || '',
        importo:     record.Importo,
        categoria:   catNome,
        note:        record.Note || '',
        user_id:     user.id
      };

      let res;
      if (record.MdbID && record.MdbID > 0) {
        // UPDATE
        res = await _sb.from('spese').update(row).eq('id', record.MdbID).select().single();
      } else {
        // INSERT
        res = await _sb.from('spese').insert(row).select().single();
      }
      if (res.error) throw res.error;
      record.MdbID = res.data.id;
      return { success: true, record, supabaseSaved: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Salva entrata ─────────────────────────────────────────────
  saveEntrata: async (record) => {
    try {
      const user = await sbCurrentUser();
      if (!user) return { success: false, error: 'not_authenticated' };

      // Risolvi nome categoria
      let catNome = record.Categoria || '';
      if (!catNome && record.IDCategoria) {
        const cat = (DB.categorieEntrate || []).find(c => c.ID == record.IDCategoria);
        catNome = cat ? cat.Nome : '';
      }

      const row = {
        data:        record.Data,
        descrizione: record.Descrizione || '',
        importo:     record.Importo,
        categoria:   catNome,
        note:        record.Note || '',
        user_id:     user.id
      };

      let res;
      if (record.MdbID && record.MdbID > 0) {
        res = await _sb.from('entrate').update(row).eq('id', record.MdbID).select().single();
      } else {
        res = await _sb.from('entrate').insert(row).select().single();
      }
      if (res.error) throw res.error;
      record.MdbID = res.data.id;
      return { success: true, record, supabaseSaved: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Elimina record ────────────────────────────────────────────
  deleteRecord: async (tipo, id, mdbId) => {
    try {
      const table = tipo === 'spesa' ? 'spese' : 'entrate';

      // Risolvi l'ID Supabase: preferisce mdbId, altrimenti cerca MdbID nel DB locale
      let sbId = (mdbId && mdbId > 0) ? mdbId : 0;
      if (!sbId) {
        const arr = tipo === 'spesa' ? (DB.dati || []) : (DB.datiEntrate || []);
        const rec = arr.find(r => r.ID === id);
        sbId = rec ? rec.MdbID : 0;
      }

      if (!sbId || sbId <= 0) return { success: false, error: 'ID Supabase non trovato' };
      const { error } = await _sb.from(table).delete().eq('id', sbId);
      if (error) throw error;
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Salva categoria ───────────────────────────────────────────
  saveCategoria: async (tipo, record) => {
    try {
      const user = await sbCurrentUser();
      if (!user) return { success: false, error: 'not_authenticated' };
      const table = tipo === 'spesa' ? 'categorie' : 'categorie_entrate';
      const row = { nome: record.Nome, colore: record.Colore, user_id: user.id };

      let res;
      if (record.ID && record.ID > 0) {
        res = await _sb.from(table).update(row).eq('id', record.ID).select().single();
      } else {
        res = await _sb.from(table).insert(row).select().single();
      }
      if (res.error) throw res.error;
      record.ID = res.data.id;
      return { success: true, record };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Elimina categoria ─────────────────────────────────────────
  deleteCategoria: async (tipo, id) => {
    try {
      const table = tipo === 'spesa' ? 'categorie' : 'categorie_entrate';
      const { error } = await _sb.from(table).delete().eq('id', id);
      if (error) throw error;
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Export CSV (browser download) ────────────────────────────
  exportCSV: async (tipo) => {
    try {
      const table = tipo === 'spese' ? 'spese' : 'entrate';
      const { data, error } = await _sb.from(table).select('*').order('data', { ascending: false });
      if (error) throw error;

      const header = 'ID;Data;Descrizione;Importo;Categoria;Note';
      const rows = data.map(r =>
        [r.id, r.data, `"${r.descrizione}"`, r.importo, `"${r.categoria}"`, `"${r.note||''}"`].join(';')
      );
      const csv = '\uFEFF' + header + '\n' + rows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `budget_${tipo}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Stub per compatibilità Electron (non usati in web) ────────
  openMdb:           async () => ({ success: false, error: 'Non disponibile in modalità web' }),
  disconnectMdb:     async () => ({ success: true }),
  driveOAuthStart:   async () => ({ success: false, error: 'Google Drive non più necessario' }),
  driveRefreshToken: async () => ({ success: false, error: 'Google Drive non più necessario' }),
  openExternal:      async (url) => { window.open(url, '_blank'); },
  onMenuEvent:       ()  => {}  // no menu in browser
};

// ── UI Login overlay (iniettata dinamicamente) ──────────────────

function sbShowLoginUI(onSuccess) {
  // Rimuovi eventuale overlay esistente
  document.getElementById('_sb_login_overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_sb_login_overlay';
  overlay.innerHTML = `
    <style>
      #_sb_login_overlay {
        position:fixed;inset:0;z-index:99999;
        background:#080b12;
        display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,'SF Pro Display',sans-serif;
      }
      ._sb_box {
        background:#131629;border:1px solid #252a45;border-radius:20px;
        padding:40px 36px;width:100%;max-width:380px;
        box-shadow:0 24px 64px rgba(0,0,0,.8);
      }
      ._sb_logo { font-size:22px;font-weight:900;letter-spacing:.1em;color:#eef0f8;
                  display:flex;align-items:center;gap:10px;margin-bottom:8px; }
      ._sb_logo span { width:10px;height:10px;border-radius:50%;background:#4f8ef7;display:inline-block; }
      ._sb_sub { font-size:12px;color:#6b7299;margin-bottom:32px; }
      ._sb_label { font-size:11px;font-weight:700;color:#6b7299;text-transform:uppercase;
                   letter-spacing:.06em;margin-bottom:6px; }
      ._sb_input {
        width:100%;background:#1a1e32;border:1px solid #252a45;border-radius:10px;
        color:#eef0f8;padding:12px 14px;font-size:14px;outline:none;
        margin-bottom:16px;box-sizing:border-box;transition:border-color .2s;
      }
      ._sb_input:focus { border-color:#4f8ef7; }
      ._sb_btn {
        width:100%;background:#4f8ef7;border:none;border-radius:10px;
        color:#fff;font-size:14px;font-weight:700;padding:13px;cursor:pointer;
        transition:opacity .2s;margin-top:4px;
      }
      ._sb_btn:hover { opacity:.88; }
      ._sb_btn:disabled { opacity:.5;cursor:default; }
      ._sb_err { color:#f0566a;font-size:12px;margin-top:10px;min-height:18px; }
    </style>
    <div class="_sb_box">
      <div class="_sb_logo"><span></span>BUDGET DOMESTICO</div>
      <div class="_sb_sub">Accedi per sincronizzare i tuoi dati</div>
      <div class="_sb_label">Email</div>
      <input class="_sb_input" id="_sb_email" type="email" placeholder="nome@esempio.com" autocomplete="email">
      <div class="_sb_label">Password</div>
      <input class="_sb_input" id="_sb_pwd" type="password" placeholder="••••••••" autocomplete="current-password">
      <button class="_sb_btn" id="_sb_submit">Accedi</button>
      <div class="_sb_err" id="_sb_err"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const emailEl  = document.getElementById('_sb_email');
  const pwdEl    = document.getElementById('_sb_pwd');
  const btnEl    = document.getElementById('_sb_submit');
  const errEl    = document.getElementById('_sb_err');

  const doLogin = async () => {
    const email = emailEl.value.trim();
    const pwd   = pwdEl.value;
    if (!email || !pwd) { errEl.textContent = 'Inserisci email e password'; return; }
    btnEl.disabled = true;
    btnEl.textContent = 'Accesso in corso...';
    errEl.textContent = '';
    try {
      await sbSignIn(email, pwd);
      overlay.remove();
      if (onSuccess) onSuccess();
    } catch (e) {
      errEl.textContent = 'Credenziali non valide. Riprova.';
      btnEl.disabled = false;
      btnEl.textContent = 'Accedi';
    }
  };

  btnEl.addEventListener('click', doLogin);
  pwdEl.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') pwdEl.focus(); });

  // Focus automatico
  setTimeout(() => emailEl.focus(), 100);
}

// ── Init automatico: controlla sessione all'avvio ───────────────
// Questa funzione è chiamata da index.html e budget-mobile.html
// al posto della vecchia init() o in testa ad essa.

async function sbInit(onReady) {
  const user = await sbCurrentUser();
  if (user) {
    if (onReady) onReady();
  } else {
    sbShowLoginUI(onReady);
  }
}

// ══════════════════════════════════════════════════════════════
//  SUPABASE SYNC — Mobile (budget-mob.html)
// ══════════════════════════════════════════════════════════════

async function sbSyncLoad() {
  const btn = document.getElementById('sb-sync-btn');
  if (btn) { btn.textContent = '⟳ Sync...'; btn.disabled = true; }
  try {
    const user = await sbCurrentUser();
    if (!user) { sbShowLoginUI(() => sbSyncLoad()); return; }

    const [rCats, rCatsEn, speseData, entrateData] = await Promise.all([
      _sb.from('categorie').select('*').order('nome'),
      _sb.from('categorie_entrate').select('*').order('nome'),
      _fetchAll('spese', 'data', false),
      _fetchAll('entrate', 'data', false)
    ]);

    const cats = {
      spese:   (rCats.data   || []).map(r => ({ ID: r.id, Nome: r.nome, Colore: r.colore })),
      entrate: (rCatsEn.data || []).map(r => ({ ID: r.id, Nome: r.nome, Colore: r.colore }))
    };

    const catMapSp = {}; cats.spese.forEach(c => { catMapSp[c.Nome?.toLowerCase()] = c.ID; });
    const catMapEn = {}; cats.entrate.forEach(c => { catMapEn[c.Nome?.toLowerCase()] = c.ID; });

    const records = [
      ...(speseData || []).map(r => ({
        id:      'sb_sp_' + r.id,
        sbId:    r.id,
        tipo:    'sp',
        data:    r.data,
        desc:    r.descrizione || '',
        importo: parseFloat(r.importo) || 0,
        idCat:   catMapSp[r.categoria?.toLowerCase()] || 1,
        cat:     r.categoria || '',
        note:    r.note || ''
      })),
      ...(entrateData || []).map(r => ({
        id:      'sb_en_' + r.id,
        sbId:    r.id,
        tipo:    'en',
        data:    r.data,
        desc:    r.descrizione || '',
        importo: parseFloat(r.importo) || 0,
        idCat:   catMapEn[r.categoria?.toLowerCase()] || 1,
        cat:     r.categoria || '',
        note:    r.note || ''
      }))
    ];

    localStorage.setItem('budget_mobile_records', JSON.stringify(records));
    localStorage.setItem('budget_mobile_cats', JSON.stringify(cats));

    if (typeof showToast === 'function') showToast(`✓ ${records.length} record sincronizzati`, 'success');
    if (typeof _refreshCurrentPage === 'function') _refreshCurrentPage();
    if (typeof updateTopbarCount === 'function') updateTopbarCount();
  } catch(e) {
    if (typeof showToast === 'function') showToast('❌ Errore sync: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '☁ Sync'; btn.disabled = false; }
  }
}

async function sbSaveRecord(rec) {
  try {
    const user = await sbCurrentUser();
    if (!user) return false;
    const cats = typeof getCats === 'function' ? getCats() : { spese: [], entrate: [] };
    const catList = rec.tipo === 'sp' ? cats.spese : cats.entrate;
    const catObj = catList.find(c => c.ID === rec.idCat);
    const categoria = catObj ? catObj.Nome : (rec.cat || '');
    const table = rec.tipo === 'sp' ? 'spese' : 'entrate';
    const row = { data: rec.data, descrizione: rec.desc || '', importo: rec.importo, categoria, note: rec.note || '', user_id: user.id };
    const { data, error } = await _sb.from(table).insert(row).select().single();
    if (error) throw error;
    rec.id   = 'sb_' + rec.tipo + '_' + data.id;
    rec.sbId = data.id;
    return true;
  } catch(e) {
    console.error('[sbSaveRecord]', e.message);
    return false;
  }
}

async function sbDeleteRecord(rec) {
  try {
    if (!rec.sbId) return false;
    const user = await sbCurrentUser();
    if (!user) return false;
    const table = rec.tipo === 'sp' ? 'spese' : 'entrate';
    const { error } = await _sb.from(table).delete().eq('id', rec.sbId);
    if (error) throw error;
    return true;
  } catch(e) {
    console.error('[sbDeleteRecord]', e.message);
    return false;
  }
}

async function sbSyncNow() {
  await sbSyncLoad();
}

async function sbLogoutMobile() {
  if (!confirm('Disconnettersi da Budget Domestico?')) return;
  await sbSignOut();
  if (typeof showToast === 'function') showToast('Disconnesso da Supabase');
}
