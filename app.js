// ============================================================
// CONFIGURAÇÃO
// ============================================================
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwX8avRK6Mh3jBx7XCoUCUS1lfR0tGJBGcN68zv_WRpRMSIF3EDdC-2GkbpvoGXV-mr-Q/exec';
const SESSAO_DURACAO_H = 24;
// Notificações do navegador e WhatsApp ficam desligadas neste produto
const PUSH_ATIVO = false;

// Mercado Livre — conexão obrigatória no primeiro acesso
const ML_CLIENT_ID = '3936370948601703';
const ML_REDIRECT_URI = location.origin + '/callback';
const ML_CONSENTIMENTO_VERSAO = '2026-10';
let _mlConectado = false;

// Firebase config
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDPJ_pTtcBdOqwYi8bZVWDKEfzzcx3nV5g",
  authDomain: "calculadora-real-produto.firebaseapp.com",
  projectId: "calculadora-real-produto",
  storageBucket: "calculadora-real-produto.firebasestorage.app",
  messagingSenderId: "900002705851",
  appId: "1:900002705851:web:33a355b59ad8099c41549e"
};

// ============================================================
// FIREBASE — inicialização garantida
// ============================================================
let _firebaseInitialized = false;

function ensureFirebase() {
  if (_firebaseInitialized) return;
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }
  _firebaseInitialized = true;
}

let _db = null;
async function getDB() {
  ensureFirebase();
  if (_db) return _db;
  _db = firebase.firestore();
  return _db;
}

let _auth = null;
async function getAuth() {
  ensureFirebase();
  if (_auth) return _auth;
  _auth = firebase.auth();
  return _auth;
}

function loadScript(src){
  return new Promise((res,rej)=>{
    if(document.querySelector(`script[src="${src}"]`)){res();return;}
    const s=document.createElement('script');
    s.src=src;s.onload=res;s.onerror=rej;
    document.head.appendChild(s);
  });
}

// Retorna o identificador do usuário atual (email do Firebase Auth ou chave legada)
// Cache do usuário atual — evita criar múltiplos listeners
let _cachedUserId = null;
let _authResolved = false;
let _authResolveCallbacks = [];

// Chamado uma única vez pelo onAuthStateChanged global
function _setAuthUser(user) {
  _cachedUserId = (user && user.email) ? user.email : null;
  _authResolved = true;
  _authResolveCallbacks.forEach(cb => cb(_cachedUserId));
  _authResolveCallbacks = [];
}

async function getUserId() {
  ensureFirebase();

  // Já resolvido — retorna direto sem criar novo listener
  if (_authResolved) return _cachedUserId;

  // Se Firebase já tem usuário, retorna imediatamente
  const auth = firebase.auth();
  if (auth.currentUser && auth.currentUser.email) {
    return auth.currentUser.email;
  }

  // Aguarda resolução com timeout de 5s para não travar eternamente
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Timeout — remove callback e retorna null
      _authResolveCallbacks = _authResolveCallbacks.filter(cb => cb !== resolve);
      const s = verificarSessao();
      resolve(s ? (s.email || s.chave) : null);
    }, 5000);

    _authResolveCallbacks.push((uid) => {
      clearTimeout(timer);
      resolve(uid);
    });
  });
}

// Retorna ref do doc do usuário atual
async function userDoc(colecao){
  const uid = await getUserId();
  if(!uid) return null;
  const db=await getDB();
  return db.collection('usuarios').doc(uid).collection(colecao);
}

// Salva array no Firebase (sobrescreve a coleção com um único doc "data")
// ============================================================
// ISOLAMENTO DE DADOS POR USUÁRIO — evita vazamento entre contas
// no mesmo navegador. Chaves genéricas de localStorage eram
// compartilhadas: quem logasse depois via os dados do anterior.
// ============================================================
function localKey(baseKey){
  const uid = firebase.auth().currentUser ? firebase.auth().currentUser.email : null;
  if(!uid) return null;                     // sem usuário logado → nunca usa cache
  return baseKey + '_' + uid.replace(/[^a-zA-Z0-9]/g,'_');
}

function getCached(baseKey, fallback='[]'){
  const key = localKey(baseKey);
  if(!key) return JSON.parse(fallback);
  return JSON.parse(localStorage.getItem(key) || fallback);
}

function setCached(baseKey, dados){
  const key = localKey(baseKey);
  if(key) localStorage.setItem(key, JSON.stringify(dados));
}

const _MAPA_COLECAO = {produtos:'realecom_prods', eventos:'realecom_eventos', metas:'realecom_metas'};

async function fbSet(colecao, dados){
  try{
    const uid = await getUserId();
    if(!uid) return;
    setCached(_MAPA_COLECAO[colecao] || colecao, dados);
    const db=await getDB();
    await db.collection('usuarios').doc(uid)
      .collection(colecao).doc('data')
      .set({payload: JSON.stringify(dados), ts: Date.now()});
  }catch(e){ console.warn('Firebase write error:', e); }
}

// Lê array do Firebase, fallback para localStorage
async function fbGet(colecao, baseKey, fallback){
  try{
    const uid = await getUserId();
    if(!uid) return JSON.parse(fallback);   // sem uid → nunca usa cache
    const userKey = localKey(baseKey);
    const db=await getDB();
    const doc=await db.collection('usuarios').doc(uid)
      .collection(colecao).doc('data').get();
    if(doc.exists){
      const dados=JSON.parse(doc.data().payload);
      if(userKey) localStorage.setItem(userKey, JSON.stringify(dados));
      return dados;
    }
    if(userKey) localStorage.removeItem(userKey);
    return JSON.parse(fallback);
  }catch(e){
    console.warn('Firebase read error:', e);
    const userKey = localKey(baseKey);      // em erro de rede: cache SÓ do usuário atual
    if(userKey){
      const cached = localStorage.getItem(userKey);
      if(cached) return JSON.parse(cached);
    }
    return JSON.parse(fallback);
  }
}

// Registra atividade do usuário no Firebase (para o admin ver)
async function registrarAtividade(acao){
  try{
    const uid = await getUserId();
    if(!uid) return;
    const s=verificarSessao();
    const db=await getDB();
    // Só grava o nome se ele existir de verdade — antes, sem sessão local
    // (entrada automática), gravava nome:'' e apagava o nome da conta no Firestore.
    const reg={email: uid, ultimaAtividade: Date.now(), ultimaAcao: acao};
    if(s && s.nome && s.nome!==uid) reg.nome=s.nome;
    await db.collection('usuarios').doc(uid).set(reg,{merge:true});
  }catch(e){}
}

// ============================================================
// LOGIN — Firebase Auth (email + senha)
// ============================================================

function verificarSessao(){
  // Compatibilidade: retorna usuário do Firebase ou sessão antiga
  try{
    const s=JSON.parse(localStorage.getItem('realecom_sessao')||'null');
    if(!s)return false;
    const agora=Date.now();
    if(agora>s.expira){localStorage.removeItem('realecom_sessao');return false;}
    return s;
  }catch(e){return false;}
}

function salvarSessao(dados){
  try{
    const expira=Date.now()+(SESSAO_DURACAO_H*60*60*1000);
    localStorage.setItem('realecom_sessao',JSON.stringify({...dados,expira}));
  }catch(e){}
}

// A fonte da verdade de "está logado" é o Firebase Auth (que fica salvo no
// navegador e entra sozinho). A sessão local de 24h é só cache de nome/validade.
// Antes, a troca de página olhava SÓ a sessão local: quem entrava automático
// (Chrome/tablet) não tinha essa sessão, e cada clique recarregava o site e
// jogava a pessoa de volta pro início.
function estaLogado(){
  try{
    const u = firebase.auth().currentUser;
    if(_jaEntrou && u && u.email) return true;
  }catch(e){}
  return !!verificarSessao();
}

async function sair(){
  if(!confirm('Deseja sair da sua conta?'))return;
  const sb=document.getElementById('sidebar');
  if(sb)sb.style.display='none';
  // Pega o e-mail ANTES do signOut — depois dele currentUser já é null
  // e os caches da conta nunca eram limpos
  const _uid = firebase.auth().currentUser ? firebase.auth().currentUser.email : null;
  const _safe = _uid ? _uid.replace(/[^a-zA-Z0-9]/g,'_') : null;
  _fazendoLogout = true;
  try{const auth=await getAuth();await auth.signOut();}catch(e){}
  // Limpa TODOS os dados do usuário do localStorage ao sair
  // Evita vazamento para quem logar depois neste mesmo PC
  ['realecom_sessao','realecom_prods','realecom_eventos','realecom_metas',
   'realecom_sazonal_sel','realecom_telefone','realecom_pub_historico','realecom_ncm_hist']
   .forEach(k=>{ localStorage.removeItem(k); if(_safe) localStorage.removeItem(k+'_'+_safe); });
  localStorage.removeItem('realecom_pagina');
  // Reseta cache de auth para não usar userId do usuário anterior
  _cachedUserId = null;
  _authResolved = false;
  _jaEntrou = false;
  location.reload();
}

async function fazerLogin(){
  const email=document.getElementById('login-email').value.trim().toLowerCase();
  const senha=document.getElementById('login-senha').value;
  if(!email||!senha){mostrarErroLogin('Preencha o e-mail e a senha.');return;}

  const btn=document.getElementById('btn-login');
  const loading=document.getElementById('login-loading');
  btn.disabled=true;
  (function(){const el=document.getElementById('login-erro');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('login-validade');if(el)el.style.display='none';})();
  loading.style.display='block';

  try{
    const auth=await getAuth();
    const cred=await auth.signInWithEmailAndPassword(email,senha);
    const uid=cred.user.uid;

    // Busca dados do usuário no Firestore
    const db=await getDB();
    const doc=await db.collection('usuarios').doc(email).get();

    loading.style.display='none';

    if(!doc.exists){
      mostrarErroLogin('Conta não encontrada. Entre em contato com o suporte.');
      await auth.signOut();
      btn.disabled=false;
      return;
    }

    const dados=doc.data();

    // Verifica se está ativo e dentro do prazo
    if(!dados.ativo){
      mostrarErroLogin('Sua conta está inativa. Entre em contato com o suporte.');
      await auth.signOut();
      btn.disabled=false;
      return;
    }

    // Verifica validade
    if(dados.validade){
      const partes=dados.validade.split('/');
      const validade=new Date(partes[2],partes[1]-1,partes[0]);
      validade.setHours(23,59,59);
      if(new Date()>validade){
        mostrarErroLogin('Seu acesso expirou em '+dados.validade+'. Renove sua assinatura.');
        await auth.signOut();
        btn.disabled=false;
        return;
      }
    }

    salvarSessao({email,nome:dados.nome||email,validade:dados.validade||'—',uid});
    const el=document.getElementById('login-validade');
    el.style.display='block';
    el.textContent=`✅ Bem-vindo, ${dados.nome||email}!`;
    // NÃO chama entrarNoApp() aqui. O signInWithEmailAndPassword acima já dispara
    // o onAuthStateChanged global, que é quem entra no app — com a trava _jaEntrou
    // certa e lendo a página/dados da extensão direito. Chamar aqui TAMBÉM criava
    // uma corrida: as duas chamadas disparavam quase juntas, e a desta função
    // (900ms depois, sem saber da extensão) sempre vencia por último e jogava
    // o usuário de volta pra home — mesmo depois do preço já ter sido preenchido.

  }catch(e){
    loading.style.display='none';
    btn.disabled=false;
    const msgs={
      'auth/user-not-found':'E-mail não cadastrado.',
      'auth/wrong-password':'Senha incorreta.',
      'auth/invalid-email':'E-mail inválido.',
      'auth/too-many-requests':'Muitas tentativas. Aguarde alguns minutos.',
      'auth/invalid-credential':'E-mail ou senha incorretos.',
    };
    mostrarErroLogin(msgs[e.code]||'Erro ao entrar. Tente novamente.');
  }
}

async function esqueceuSenha(){
  const email=document.getElementById('login-email').value.trim().toLowerCase();
  if(!email){mostrarErroLogin('Digite seu e-mail acima para recuperar a senha.');return;}
  try{
    const auth=await getAuth();
    await auth.sendPasswordResetEmail(email);
    const el=document.getElementById('login-validade');
    el.style.display='block';
    el.style.background='#05291622';
    el.style.borderColor='#16a34a44';
    el.style.color='var(--in)';
    el.textContent='📧 E-mail de recuperação enviado! Verifique sua caixa de entrada.';
    (function(){const el=document.getElementById('login-erro');if(el)el.style.display='none';})();
  }catch(e){
    mostrarErroLogin('Não foi possível enviar o e-mail. Verifique se o endereço está correto.');
  }
}

function mostrarErroLogin(msg){
  const el=document.getElementById('login-erro');
  el.textContent=msg;
  el.style.display='block';
}

function entrarNoApp(dados, pagina){
  if(!_mlConectado){ mostrarConexaoML(dados, pagina); return; }
  // Mostra sidebar
  const sb = document.getElementById('sidebar');
  if(sb) sb.style.display='flex';

  // Iniciais no avatar
  const elIniciais = document.getElementById('sb-iniciais');
  if(elIniciais && dados && dados.nome){
    const partes = dados.nome.trim().split(' ');
    const iniciais = partes.length>=2 ? partes[0][0]+partes[partes.length-1][0] : partes[0].substring(0,2);
    elIniciais.textContent = iniciais.toUpperCase();
  }

  const hu=document.getElementById('home-usuario');
  if(hu&&dados&&dados.nome){
    hu.innerHTML=`👋 Olá, <strong style="color:var(--o)">${dados.nome}</strong>`;
  }
  // KPIs da home
  const elVal=document.getElementById('home-kpi-validade');
  if(elVal) elVal.textContent=dados.validade&&dados.validade!=='—'?dados.validade:'Sem expiração';
  const elPlano=document.getElementById('home-kpi-plano');
  if(elPlano) elPlano.textContent=dados.plano?'Plano '+dados.plano:'Acesso liberado';

  fbGet('produtos','realecom_prods','[]').then(prods=>{
    setCached('realecom_prods',prods);

    // Dashboard KPI — total e distribuição de margem
    const elProds=document.getElementById('home-kpi-prods');
    if(elProds) elProds.textContent=prods.length;
    const elDashSub=document.getElementById('home-dash-sub');
    if(elDashSub) elDashSub.textContent=prods.length+' produto'+(prods.length!==1?'s':'')+' salvos';

    const total=prods.length||1;
    const m10=prods.filter(p=>parseFloat(p.margem)>=10&&parseFloat(p.margem)<15).length;
    const m15=prods.filter(p=>parseFloat(p.margem)>=15&&parseFloat(p.margem)<20).length;
    const m20=prods.filter(p=>parseFloat(p.margem)>=20).length;
    const setBar=(id,val,tot)=>{const el=document.getElementById(id);if(el)el.style.width=Math.round((val/tot)*100)+'%';};
    const setTxt=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val;};
    setTxt('home-m10',m10); setBar('home-bar10',m10,total);
    setTxt('home-m15',m15); setBar('home-bar15',m15,total);
    setTxt('home-m20',m20); setBar('home-bar20',m20,total);

    // Metas KPI
    const metaObj=getCached('realecom_metas','{}');
    const prodDia=parseInt(metaObj.prodDia)||0;
    const diasSem=parseInt(metaObj.diasSemana)||0;
    if(prodDia&&diasSem){
      const agora=Date.now();
      const metaSem=prodDia*diasSem, metaMes=metaSem*4;
      const metaDia=prodDia;
      const hoje0=new Date();hoje0.setHours(0,0,0,0);
      const pDia=prods.filter(p=>p.id>=hoje0.getTime()).length;
      const pSem=prods.filter(p=>p.id>=agora-7*864e5).length;
      const pMes=prods.filter(p=>p.id>=agora-30*864e5).length;
      setTxt('home-meta-dia',`${pDia}/${metaDia}`);
      setTxt('home-meta-sem',`${pSem}/${metaSem}`);
      setTxt('home-meta-mes',`${pMes}/${metaMes}`);
      setBar('home-bar-dia',pDia,metaDia||1);
      setBar('home-bar-sem',pSem,metaSem||1);
      setBar('home-bar-mes',pMes,metaMes||1);
    }else{
      ['home-meta-dia','home-meta-sem','home-meta-mes'].forEach(id=>setTxt(id,'—'));
    }
  });
  fbGet('eventos','realecom_eventos','[]').then(evs=>{
    setCached('realecom_eventos',evs);
    // Calendário home — eventos de hoje e próximos
    const hoje=new Date();hoje.setHours(0,0,0,0);
    const hojeStr=hoje.toISOString().split('T')[0];
    const cores={full:'var(--text2)',conta:'var(--out)',entrega:'var(--in)',outro:'var(--text2)'};
    const proximos=evs.filter(e=>{
      const d=new Date(e.data+'T00:00:00');
      return d>=hoje;
    }).sort((a,b)=>a.data.localeCompare(b.data)).slice(0,3);

    const elCal=document.getElementById('home-cal-eventos');
    const elCalTit=document.getElementById('home-cal-titulo');
    if(elCalTit) elCalTit.textContent='Hoje · '+hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    if(elCal){
      if(!proximos.length){
        elCal.innerHTML='<div style="font-size:.7rem;color:var(--text3)">Nenhum evento próximo</div>';
      }else{
        elCal.innerHTML=proximos.map(e=>{
          const isHoje=e.data===hojeStr;
          const d=new Date(e.data+'T00:00:00');
          const diffDias=Math.round((d-hoje)/(864e5));
          const label=isHoje?'Hoje':diffDias===1?'Amanhã':'Em '+diffDias+' dias';
          return`<div style="display:flex;gap:6px;align-items:center">
            <div style="width:3px;height:26px;background:${cores[e.tipo]||'var(--text2)'};border-radius:2px;flex-shrink:0"></div>
            <div>
              <div style="font-size:.72rem;font-weight:600;color:var(--text)">${e.titulo}</div>
              <div style="font-size:.65rem;color:var(--text3)">${label}</div>
            </div>
          </div>`;
        }).join('');
      }
    }
  });
  fbGet('metas','realecom_metas','{}').then(m=>{
    setCached('realecom_metas',m);
  });
  registrarAtividade('login');
  inicializarPush();
  setTimeout(()=>{
    // Dados vindos da extensão do Mercado Livre (botão "Enviar para a Calculadora")
    const dadosExt = lerDadosDaExtensao();
    if(dadosExt) pagina = 'calc';

    showPage(pagina||'home', true);

    if(dadosExt){
      setTimeout(() => aplicarDadosDaExtensao(dadosExt), 200);
    } else {
      setTimeout(()=>verificarConfirmacoesSazonais(), 800);
    }
  }, 50);
}

// Verifica sessão ao carregar — baseado no Firebase Auth
// Flags globais de controle de auth — precisam ser acessíveis pelo sair()
let _fazendoLogout = false;
let _jaEntrou = false;

(function(){
  // Tema pode ser aplicado imediatamente, não depende de auth
  const t=localStorage.getItem('realecom_theme');
  if(t==='light'){document.body.classList.add('light');document.querySelectorAll('.theme-toggle').forEach(b=>b.textContent='🌙 Escuro');}

  ensureFirebase();

  firebase.auth().onAuthStateChanged(async (user) => {
    // Se estamos fazendo logout manual, ignora completamente
    if(_fazendoLogout) return;
    // Se _jaEntrou já está true, ignora disparos subsequentes (renovação de token, foco de aba)
    if(_jaEntrou && user) return;

    // Resolve o cache de userId para todas as chamadas pendentes
    _setAuthUser(user);

    if(!user){
      // Só limpa e mostra login se não estamos fazendo logout manual
      if(!_fazendoLogout){
        localStorage.removeItem('realecom_sessao');
        _jaEntrou = false;
      }
      return;
    }

    // Se já entrou no app nesta sessão, ignora disparos subsequentes do onAuthStateChanged
    // (Firebase dispara ao renovar token, ao mudar foco da aba, etc.)
    if(_jaEntrou) return;

    // Primeira vez — valida no Firestore se está ativo e dentro do prazo
    try{
      const db = await getDB();
      const doc = await db.collection('usuarios').doc(user.email).get();

      if(!doc.exists){
        _fazendoLogout = true;
        await firebase.auth().signOut();
        localStorage.removeItem('realecom_sessao');
        _fazendoLogout = false;
        return;
      }

      const dados = doc.data();

      if(!dados.ativo){
        _fazendoLogout = true;
        await firebase.auth().signOut();
        localStorage.removeItem('realecom_sessao');
        _fazendoLogout = false;
        mostrarErroLogin('Sua conta está inativa. Entre em contato com o suporte.');
        return;
      }

      if(dados.validade){
        const partes = dados.validade.split('/');
        const validade = new Date(partes[2], partes[1]-1, partes[0]);
        validade.setHours(23,59,59);
        if(new Date() > validade){
          _fazendoLogout = true;
          await firebase.auth().signOut();
          localStorage.removeItem('realecom_sessao');
          _fazendoLogout = false;
          mostrarErroLogin('Seu acesso expirou em '+dados.validade+'. Renove sua assinatura.');
          return;
        }
      }

      // Tudo ok — marca que já entrou e vai para o app
      _jaEntrou = true;
      _mlConectado = !!dados.ml_conectado;
      // Carrega telefone já aqui para o banner do calendário funcionar imediatamente
      if(dados.telefone){
        setCached('realecom_telefone', dados.telefone);
      } else {
        (function(){const k=localKey('realecom_telefone');if(k)localStorage.removeItem(k);})();
      }
      const ultimaPagina = localStorage.getItem('realecom_pagina')||'home';
      const dadosSessao = {
        email: user.email,
        nome: dados.nome || user.email,
        validade: dados.validade || '—',
        plano: dados.plano || '',
        uid: user.uid
      };
      // Entrada automática (navegador já logado) também grava a sessão local —
      // antes só o login manual gravava, e a navegação quebrava.
      salvarSessao(dadosSessao);
      entrarNoApp(dadosSessao, ultimaPagina);

    }catch(e){
      console.warn('Erro ao validar sessão:', e);
      // Em caso de erro de rede, usa sessão salva como fallback
      const s = verificarSessao();
      if(s && !_jaEntrou){
        _jaEntrou = true;
        const ultimaPagina = localStorage.getItem('realecom_pagina')||'home';
        entrarNoApp({
          email: user.email,
          nome: s.nome || user.email,
          validade: s.validade || '—',
          plano: s.plano || ''
        }, ultimaPagina);
      }
    }
  });

  // Logout automático por inatividade — 2 horas sem interação
  let _timerInatividade;
  function resetarTimerInatividade(){
    clearTimeout(_timerInatividade);
    _timerInatividade = setTimeout(async ()=>{
      if(firebase.auth().currentUser){
        const _uid = firebase.auth().currentUser.email || null;
        const _safe = _uid ? _uid.replace(/[^a-zA-Z0-9]/g,'_') : null;
        _fazendoLogout = true;
        _jaEntrou = false;
        await firebase.auth().signOut();
  ['realecom_sessao','realecom_prods','realecom_eventos','realecom_metas',
   'realecom_sazonal_sel','realecom_telefone','realecom_pub_historico','realecom_ncm_hist']
   .forEach(k=>{ localStorage.removeItem(k); if(_safe) localStorage.removeItem(k+'_'+_safe); });
        _cachedUserId = null;
        _authResolved = false;
        _fazendoLogout = false;
        location.reload();
      }
    }, 2 * 60 * 60 * 1000); // 2 horas
  }
  // Reseta o timer em qualquer interação do usuário
  ['click','keydown','touchstart','scroll'].forEach(ev=>{
    document.addEventListener(ev, resetarTimerInatividade, {passive:true});
  });
  resetarTimerInatividade();
})();

// ============================================================
// APP
// ============================================================
const pesoFaixas=[[0,.3],[.3,.5],[.5,1],[1,1.5],[1.5,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,13],[13,15],[15,17],[17,20],[20,25],[25,30],[30,40],[40,50],[50,60],[60,70],[70,80],[80,90],[90,100],[100,125],[125,150],[150,1e9]];
const pesoLabels=['Até 0,3kg','0,3–0,5kg','0,5–1kg','1–1,5kg','1,5–2kg','2–3kg','3–4kg','4–5kg','5–6kg','6–7kg','7–8kg','8–9kg','9–10kg','10–11kg','11–13kg','13–15kg','15–17kg','17–20kg','20–25kg','25–30kg','30–40kg','40–50kg','50–60kg','60–70kg','70–80kg','80–90kg','90–100kg','100–125kg','125–150kg','+150kg'];
const precoFaixas=[0,19,49,79,100,120,150,200];
const precoLabels=['R$0–18','R$19–48','R$49–78','R$79–99','R$100–119','R$120–149','R$150–199','R$200+'];
// TABELAS DE FRETE ML — vigentes desde 02/03/2026 (verificadas 22/07/2026)
// Fonte: Central de Ajuda ML (artigos 40538, 40545, 40547) via vendedorlucrativo.com.br
// Linhas = 29 faixas de peso | Colunas = 8 faixas de preço

// Verde — MercadoLíder, reputação verde ou sem reputação (menor custo)
const T=[[5.65,6.85,8.15,12.95,14.95,16.95,19.05,21.65],[5.95,6.95,8.25,13.85,16.15,18.15,20.45,23.25],[6.05,7.15,8.45,14.45,16.85,19.05,21.35,24.45],[6.15,7.35,8.65,14.75,17.15,19.45,21.75,25.45],[6.25,7.45,8.75,15.05,17.65,19.85,22.25,25.55],[6.35,8.65,9.15,16.45,19.15,21.65,24.35,27.05],[6.45,8.75,9.75,17.85,20.75,23.35,26.35,29.25],[6.55,8.85,10.25,19.75,22.85,26.05,29.25,32.45],[6.65,8.95,10.35,25.95,29.15,33.35,36.45,40.85],[6.75,9.05,10.45,27.55,31.65,36.75,40.85,45.25],[6.85,9.25,10.55,29.45,34.35,39.25,44.15,49.35],[6.95,9.35,10.65,30.25,35.25,40.35,45.35,50.75],[7.05,9.45,10.85,38.25,45.05,51.95,58.75,65.85],[7.05,9.65,11.05,41.65,48.55,55.45,62.35,69.35],[7.15,10.05,11.45,42.55,49.75,56.85,63.85,70.95],[7.25,10.25,11.65,45.55,52.95,60.55,68.15,75.65],[7.35,10.45,11.85,48.95,56.55,64.05,71.35,79.35],[7.45,10.65,12.05,55.15,64.35,73.55,82.75,91.95],[7.65,11.05,12.25,64.55,75.75,85.45,96.25,106.85],[7.75,11.25,12.45,66.45,76.05,86.25,97.15,107.85],[7.85,11.45,12.65,68.35,79.65,89.75,100.05,107.95],[7.95,11.65,12.85,70.95,81.85,92.85,103.45,111.65],[8.05,11.85,13.05,75.55,87.25,99.05,110.25,119.05],[8.15,12.05,13.25,80.95,93.75,105.95,118.05,127.45],[8.25,12.25,13.45,84.65,97.95,110.75,123.35,133.15],[8.35,12.45,13.65,94.05,108.35,122.95,136.95,147.85],[8.45,12.65,13.85,107.45,124.85,140.45,156.45,168.85],[8.55,12.85,14.05,120.15,138.95,156.95,174.85,188.85],[8.65,12.85,14.25,127.45,147.05,166.55,185.55,200.35],[8.75,12.85,14.45,167.05,193.35,218.45,243.45,262.85]];

// Amarela — ~15% a mais nas faixas até R$78,99 e ~20% a mais acima de R$79
const T_AMA=[[6.5,7.88,9.37,15.54,17.94,20.34,22.86,25.98],[6.84,7.99,9.49,16.62,19.38,21.78,24.54,27.9],[6.96,8.22,9.72,17.34,20.22,22.86,25.62,29.34],[7.07,8.45,9.95,17.7,20.58,23.34,26.1,30.54],[7.19,8.57,10.06,18.06,21.18,23.82,26.7,30.66],[7.3,9.95,10.52,19.74,22.98,25.98,29.22,32.46],[7.42,10.06,11.21,21.42,24.9,28.02,31.62,35.1],[7.53,10.18,11.79,23.7,27.42,31.26,35.1,38.94],[7.65,10.29,11.9,31.14,34.98,40.02,43.74,49.02],[7.76,10.41,12.02,33.06,37.98,44.1,49.02,54.3],[7.88,10.64,12.13,35.34,41.22,47.1,52.98,59.22],[7.99,10.75,12.25,36.3,42.3,48.42,54.42,60.9],[8.11,10.87,12.48,45.9,54.06,62.34,70.5,79.02],[8.11,11.1,12.71,49.98,58.26,66.54,74.82,83.22],[8.22,11.56,13.17,51.06,59.7,68.22,76.62,85.14],[8.34,11.79,13.4,54.66,63.54,72.66,81.78,90.78],[8.45,12.02,13.63,58.74,67.86,76.86,85.62,95.22],[8.57,12.25,13.86,66.18,77.22,88.26,99.3,110.34],[8.8,12.71,14.09,77.46,90.9,102.54,115.5,128.22],[8.91,12.94,14.32,79.74,91.26,103.5,116.58,129.42],[9.03,13.17,14.55,82.02,95.58,107.7,120.06,129.54],[9.14,13.4,14.78,85.14,98.22,111.42,124.14,133.98],[9.26,13.63,15.01,90.66,104.7,118.86,132.3,142.86],[9.37,13.86,15.24,97.14,112.5,127.14,141.66,152.94],[9.49,14.09,15.47,101.58,117.54,132.9,148.02,159.78],[9.6,14.32,15.7,112.86,130.02,147.54,164.34,177.42],[9.72,14.55,15.93,128.94,149.82,168.54,187.74,202.62],[9.83,14.78,16.16,144.18,166.74,188.34,209.82,226.62],[9.95,14.78,16.39,152.94,176.46,199.86,222.66,240.42],[10.06,14.78,16.62,200.46,232.02,262.14,292.14,315.42]];

// Laranja/Vermelha — tabela cheia, sem desconto (~dobro do verde acima de R$79)
const T_VER=[[8.08,9.8,11.65,25.9,29.9,33.9,38.1,43.3],[8.51,9.94,11.8,27.7,32.3,36.3,40.9,46.5],[8.65,10.22,12.08,28.9,33.7,38.1,42.7,48.9],[8.79,10.51,12.37,29.5,34.3,38.9,43.5,50.9],[8.94,10.65,12.51,30.1,35.3,39.7,44.5,51.1],[9.08,12.37,13.08,32.9,38.3,43.3,48.7,54.1],[9.22,12.51,13.94,35.7,41.5,46.7,52.7,58.5],[9.37,12.66,14.66,39.5,45.7,52.1,58.5,64.9],[9.51,12.8,14.8,51.9,58.3,66.7,72.9,81.7],[9.65,12.94,14.94,55.1,63.3,73.5,81.7,90.5],[9.8,13.23,15.09,58.9,68.7,78.5,88.3,98.7],[9.94,13.37,15.23,60.5,70.5,80.7,90.7,101.5],[10.08,13.51,15.52,76.5,90.1,103.9,117.5,131.7],[10.08,13.8,15.8,83.3,97.1,110.9,124.7,138.7],[10.22,14.37,16.37,85.1,99.5,113.7,127.7,141.9],[10.37,14.66,16.66,91.1,105.9,121.1,136.3,151.3],[10.51,14.94,16.95,97.9,113.1,128.1,142.7,158.7],[10.65,15.23,17.23,110.3,128.7,147.1,165.5,183.9],[10.94,15.8,17.52,129.1,151.5,170.9,192.5,213.7],[11.08,16.09,17.8,132.9,152.1,172.5,194.3,215.7],[11.23,16.37,18.09,136.7,159.3,179.5,200.1,215.9],[11.37,16.66,18.38,141.9,163.7,185.7,206.9,223.3],[11.51,16.95,18.66,151.1,174.5,198.1,220.5,238.1],[11.65,17.23,18.95,161.9,187.5,211.9,236.1,254.9],[11.8,17.52,19.23,169.3,195.9,221.5,246.7,266.3],[11.94,17.8,19.52,188.1,216.7,245.9,273.9,295.7],[12.08,18.09,19.81,214.9,249.7,280.9,312.9,337.7],[12.23,18.38,20.09,240.3,277.9,313.9,349.7,377.7],[12.37,18.38,20.38,254.9,294.1,333.1,371.1,400.7],[12.51,18.38,20.66,334.1,386.7,436.9,486.9,525.7]];

// Tabela ativa (verde por padrão)
let freteReputacao='verde'; // 'verde' | 'amarela' | 'vermelha'
function getTabela(){return freteReputacao==='amarela'?T_AMA:freteReputacao==='vermelha'?T_VER:T;}

let pesoUsado=0,freteSel=0,freteSel_col=undefined,freteMode='manual',lastCalc=null,calcMode=1;
let calAno=new Date().getFullYear(),calMes=new Date().getMonth(),evEditId=null;

function fmt(v){return'R$ '+v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtKg(v){return v%1===0?v.toFixed(0)+' kg':v.toFixed(v<1?3:2)+' kg';}
function fmtP(v){return v.toFixed(2).replace('.',',')+' %';}

function showPage(p,bypassCheck){
  // Proteção: bloqueia acesso às páginas internas sem sessão
  // Nunca recarrega a página aqui: recarregar em loop era o que mandava
  // a pessoa de volta pro início a cada clique. Sem login → mostra a tela de login.
  if(p!=='login'&&p!=='conectar'&&_jaEntrou&&!_mlConectado){ p='conectar'; }
  if(p!=='login'&&!bypassCheck&&!estaLogado()){
    const sb=document.getElementById('sidebar');if(sb)sb.style.display='none';
    p='login';
  }
  let _alvo=document.getElementById('page-'+p);
  if(!_alvo && p!=='login'){ p='home'; _alvo=document.getElementById('page-home'); }
  if(!_alvo)return;
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  _alvo.classList.add('active');

  // Destaca item ativo na sidebar
  document.querySelectorAll('.sb-item').forEach(b=>b.classList.remove('active'));
  const mapa={calc:'sb-calc',dash:'sb-dash',cal:'sb-cal',gestao:'sb-gestao',simples:'sb-simples',pub:'sb-pub',ncm:'sb-ncm',home:'sb-home',conc:'sb-conc',prompt:'sb-prompt',fin:'sb-fin'};
  if(mapa[p]){const el=document.getElementById(mapa[p]);if(el)el.classList.add('active');}

  if(p==='dash')renderDash();
  if(p==='cal'){renderCal();}
  if(p==='gestao')calcularGestao();
  if(p==='simples'){(function(){const el=document.getElementById('sn-resultado');if(el)el.style.display='none';})();(function(){const el=document.getElementById('sn-empty');if(el)el.style.display='block';})();}
  if(p==='pub'){switchPubMode('dash');renderHistoricoPublicidade();}
  if(p==='sazonal'){renderSazonalGrid();}
  if(p==='fin'){finInit();}
  if(p!=='login') registrarAtividade('nav_'+p);
  // Salvar página atual para restaurar no F5
  if(p!=='login'&&p!=='conectar')localStorage.setItem('realecom_pagina',p);
}

function toggleTheme(){
  const isLight=document.body.classList.toggle('light');
  const label=isLight?'🌙 Escuro':'☀️ Claro';
  document.querySelectorAll('.theme-toggle').forEach(b=>b.textContent=label);
  localStorage.setItem('realecom_theme',isLight?'light':'dark');
}

function getPesoIdx(p){for(let i=0;i<pesoFaixas.length;i++)if(p<=pesoFaixas[i][1])return i;return pesoFaixas.length-1;}
function getPrecoIdx(p){let c=0;for(let i=0;i<precoFaixas.length;i++)if(p>=precoFaixas[i])c=i;return c;}

function verificarFaixaFrete(){
  const aviso=document.getElementById('frete-aviso');
  if(!aviso)return;
  if(!lastCalc||freteSel_col===undefined){aviso.style.display='none';return;}
  const colCorreta=getPrecoIdx(lastCalc.preco);
  if(freteSel_col===colCorreta){
    aviso.style.cssText='display:block;margin-top:6px;background:#05291622;border:1px solid #16a34a55;border-radius:9px;padding:8px 11px;font-size:.76rem;color:var(--in);line-height:1.5';
    aviso.textContent=`✅ Faixa correta! O preço calculado (${fmt(lastCalc.preco)}) está dentro da faixa ${precoLabels[colCorreta]}.`;
  }else{
    aviso.style.cssText='display:block;margin-top:6px;background:#7f1d1d22;border:1px solid #ef444455;border-radius:9px;padding:8px 11px;font-size:.76rem;color:var(--out);line-height:1.5';
    aviso.textContent=`⚠️ Atenção: o preço calculado (${fmt(lastCalc.preco)}) corresponde à faixa ${precoLabels[getPrecoIdx(lastCalc.preco)]}, mas você selecionou ${precoLabels[freteSel_col]}.`;
  }
}

function selFrete(col,val){freteSel=val;freteSel_col=col;renderTable(col);(function(){const el=document.getElementById('frete-badge');if(el)el.style.display='block';})();(function(){const el=document.getElementById('frete-val');if(el)el.textContent=fmt(val);})();verificarFaixaFrete();}

function calcPeso(){
  const pr=parseFloat(document.getElementById('peso').value)||0;
  const c=parseFloat(document.getElementById('comp').value)||0,l=parseFloat(document.getElementById('larg').value)||0,a=parseFloat(document.getElementById('alt').value)||0;
  const pv=(c*l*a)/6000;pesoUsado=Math.max(pr,pv);freteSel=0;freteSel_col=undefined;
  (function(){const el=document.getElementById('frete-badge');if(el)el.style.display='none';})();
  const pi=document.getElementById('peso-info'),fs=document.getElementById('frete-section');
  if(pr>0||pv>0){
    pi.style.display='flex';
    (function(){const el=document.getElementById('pi-real');if(el)el.textContent=pr>0?fmtKg(pr):'—';})();
    (function(){const el=document.getElementById('pi-vol');if(el)el.textContent=pv>0?fmtKg(pv):'—';})();
    (function(){const el=document.getElementById('pi-usado');if(el)el.textContent=fmtKg(pesoUsado)+(pv>pr&&pv>0?' (vol.)':' (real)');})();
    fs.style.display='block';renderTable(-1);
  }else{pi.style.display='none';fs.style.display='none';}
}

function renderTable(selCol){
  const pi=getPesoIdx(pesoUsado),tbl=document.getElementById('frete-table');
  let h='<thead><tr><th>Peso</th>';
  for(let c=0;c<precoLabels.length;c++)h+=`<th>${precoLabels[c]}</th>`;
  h+='</tr></thead><tbody>';
  [pi-1,pi,pi+1].filter(r=>r>=0&&r<pesoLabels.length).forEach(r=>{
    const isA=r===pi;
    h+=`<tr${isA?'':' class="dim"'}><td class="pcol">${pesoLabels[r]}${isA?' ✅':''}</td>`;
    const TAB=getTabela();
    for(let c=0;c<precoLabels.length;c++){
      const sel=isA&&c===selCol,v=TAB[r][c].toFixed(2).replace('.',',');
      h+=isA?`<td class="fopt${sel?' fsel':''}" onclick="selFrete(${c},${TAB[r][c]})">R$${v}</td>`:`<td>R$${v}</td>`;
    }
    h+='</tr>';
  });
  tbl.innerHTML=h+'</tbody>';
}

function switchFrete(mode){
  freteMode=mode;
  const td=document.getElementById('tab-dim'); if(td)td.style.display=mode==='dim'?'block':'none';
  const tm=document.getElementById('tab-manual'); if(tm)tm.style.display=mode==='manual'?'block':'none';
  const bd=document.getElementById('btn-dim'); if(bd)bd.className='toggle-btn'+(mode==='dim'?' active':'');
  const bm=document.getElementById('btn-manual'); if(bm)bm.className='toggle-btn'+(mode==='manual'?' active':'');
}

// Toggle Frete Full visível
let _freteFullVisivel = false;
function toggleFreteFullVisivel(){
  _freteFullVisivel = !_freteFullVisivel;
  const panel = document.getElementById('frete-full-panel');
  const tog = document.getElementById('toggle-frete-full');
  const dot = document.getElementById('toggle-frete-full-dot');
  if(panel) panel.style.display = _freteFullVisivel ? 'block' : 'none';
  if(tog) tog.style.background = _freteFullVisivel ? '#7c3aed' : 'var(--border)';
  if(dot) dot.style.left = _freteFullVisivel ? '16px' : '2px';
  if(!_freteFullVisivel){
    const ff = document.getElementById('frete-full');
    const ffq = document.getElementById('frete-full-qtd');
    const ffr = document.getElementById('frete-full-result');
    if(ff) ff.value='';
    if(ffq) ffq.value='';
    if(ffr) ffr.style.display='none';
  }
}
function sumItems(){return[...document.querySelectorAll('.item-input')].reduce((s,e)=>s+(parseFloat(e.value)||0),0);}
function addItem(){
  const list=document.getElementById('items-list');if(list.children.length>=10)return;
  const n=list.children.length+1,d=document.createElement('div');d.className='item-row';
  d.innerHTML=`<input type="number" class="item-input" placeholder="Custo item ${n} (R$)" min="0" step="0.01"><button class="remove-btn" onclick="removeItem(this)" style="display:flex">×</button>`;
  list.appendChild(d);list.children[0].querySelector('.remove-btn').style.display='flex';
}
function removeItem(btn){btn.parentElement.remove();const rows=document.querySelectorAll('.item-row');if(rows.length===1)rows[0].querySelector('.remove-btn').style.display='none';}

function setMode(m){
  calcMode=m;
  const b1=document.getElementById('mode-btn-1'),b2=document.getElementById('mode-btn-2');
  const mb=document.getElementById('margem-block');
  const mlInput=document.getElementById('preco-ml'),mlLabel=document.getElementById('ml-label');
  if(m===1){
    b1.style.background='linear-gradient(135deg,#6B21A8,#F0A070)';b1.style.color='#fff';
    b2.style.background='none';b2.style.color='#4a3f6b';
    mb.style.display='block';mlInput.placeholder='Obrigatório';
    mlLabel.innerHTML='💛 Preço Médio ML (R$) <span style="color:var(--out);font-size:.65rem">(obrigatório)</span>';
    (function(){const el=document.getElementById('mode-desc');if(el)el.innerHTML='<strong style="color:var(--text3)">Modo Por Margem:</strong> Defina sua margem e descubra o preço mínimo ideal.';})();
    (function(){const el=document.getElementById('price-grid');if(el)el.style.gridTemplateColumns='1fr 1fr';})();
    (function(){const el=document.getElementById('pc-ml-card');if(el)el.style.display='block';})();
  }else{
    b2.style.background='linear-gradient(135deg,#6B21A8,#F0A070)';b2.style.color='#fff';
    b1.style.background='none';b1.style.color='#4a3f6b';
    mb.style.display='none';mlInput.placeholder='Obrigatório';
    mlLabel.innerHTML='💛 Preço Médio ML (R$) <span style="color:var(--out)">*</span>';
    (function(){const el=document.getElementById('mode-desc');if(el)el.innerHTML='<strong style="color:var(--text3)">Modo Pelo Mercado:</strong> Informe o preço médio ML e descubra sua margem real.';})();
  }
}

function calcular(){
  try{
    _calcularInterno();
  }catch(e){
    console.error('Erro em calcular():', e);
    // Extrai a primeira linha do stack que aponta para app.js — mostra a linha exata do erro
    const linha = (e.stack||'').split('\n').map(l=>l.trim()).find(l=>l.includes('app.js'));
    mostrarErroTela('Não foi possível calcular. ' + (e.message||'') + (linha?' — ['+linha.replace(/^at\s*/,'')+']':''));
  }
}

function _calcularInterno(){
  const custo=sumItems();
  const frete=freteMode==='manual'?(parseFloat(document.getElementById('frete-manual').value)||0):freteSel;
  // Frete de coleta Full por unidade
  const freteFullTotal=parseFloat(document.getElementById('frete-full').value)||0;
  const freteFullQtd=parseInt(document.getElementById('frete-full-qtd').value)||1;
  const freteFullUnit=freteFullTotal>0?freteFullTotal/freteFullQtd:0;
  const ins=(parseFloat(document.getElementById('insumos').value)||0)+freteFullUnit;
  const pI=(parseFloat(document.getElementById('impostos').value)||0)/100;
  const pC=(parseFloat(document.getElementById('comissao').value)||0)/100;
  const pA=(parseFloat(document.getElementById('afiliados').value)||0)/100;
  const pM=(parseFloat(document.getElementById('margem').value)||0)/100;
  const qtd=parseInt(document.getElementById('quantidade').value)||1;
  const precoML=parseFloat(document.getElementById('preco-ml').value)||0;
  const base=custo+frete+ins;

  if(calcMode===2){
    if(!precoML){alert('No Modo Pelo Mercado, informe o Preço Médio ML.');return;}
    const vI=precoML*pI,vC=precoML*pC,vA=precoML*pA;
    const payout=precoML-base-vI-vC-vA;
    const margemReal=(payout/precoML)*100;
    const markup=custo>0?precoML/custo:0;
    const inv=custo*qtd,roi=inv>0?(payout*qtd/inv)*100:0;
    lastCalc={preco:precoML,base,pI,pC,pA,pM:margemReal/100,custo,frete,ins,freteFullUnit,qtd,precoML,markup,roi,payout,inv};
    (function(){const el=document.getElementById('price-grid');if(el)el.style.gridTemplateColumns='1fr';})();
    (function(){const el=document.getElementById('pc-ml-card');if(el)el.style.display='none';})();
    const _tag2=document.querySelector('.price-card.calc .pc-tag'); if(_tag2)_tag2.textContent='Preço Médio do Mercado';
    (function(){const el=document.getElementById('pc-preco');if(el)el.textContent=fmt(precoML);})();
    (function(){const el=document.getElementById('pc-mk');if(el)el.textContent=markup.toFixed(2).replace('.',',');})();
    (function(){const el=document.getElementById('pc-roi');if(el)el.textContent=fmtP(roi);})();
    (function(){const el=document.getElementById('pc-mg');if(el)el.textContent=fmtP(margemReal);})();
    const badge=document.querySelector('.price-card.calc .pc-badge')||document.createElement('span');
    badge.textContent=margemReal>=10?'✅ Margem saudável':margemReal>=0?'⚠️ Margem baixa':'❌ Prejuízo';
    badge.style.cssText=`display:inline-block;padding:3px 10px;border-radius:20px;font-size:.67rem;font-weight:700;margin-bottom:9px;background:${margemReal>=10?'rgba(74,222,128,.2)':margemReal>=0?'rgba(240,160,112,.2)':'rgba(239,68,68,.2)'};color:${margemReal>=10?'var(--in)':margemReal>=0?'var(--text2)':'var(--out)'}`;
    const fator15=1-0.15-pI-pC-pA;
    const custoMax15=fator15>0?(precoML*fator15-frete-ins):null;
    (function(){const el=document.getElementById('explain-text');if(el)el.innerHTML=`Vendendo a <strong style="color:var(--o)">${fmt(precoML)}</strong>, sua margem real seria <strong style="color:${margemReal>=10?'var(--in)':margemReal>=0?'var(--text2)':'var(--out)'}">${fmtP(margemReal)}</strong>. ${margemReal<0?'Você está vendendo com <strong style="color:var(--out)">prejuízo</strong>.':margemReal<10?'Margem abaixo de 10% — avalie se vale a pena.':'Margem dentro de um bom patamar.'}<br><br>💡 Para ter 15% de margem vendendo a ${fmt(precoML)}, compre por no máximo <strong style="color:${custoMax15!==null&&custoMax15>0?'var(--in)':'var(--out)'}">${custoMax15!==null&&custoMax15>0?fmt(custoMax15):'Inviável com os custos atuais'}</strong>.`;})();
    if(pesoUsado>0&&freteMode==='dim'){renderTable(getPrecoIdx(precoML));verificarFaixaFrete();}
    preencherDetalhes(custo,frete,ins,base,vI,vC,vA,0,precoML,payout,qtd,inv,vI*qtd);
    (function(){const el=document.getElementById('bottom-wrapper');if(el)el.style.display='flex';})();
    finalizarCalculo();return;
  }

  const fator=1-pI-pC-pA-pM;
  if(fator<=0){alert('A soma dos percentuais é ≥ 100%. Revise os valores.');return;}
  const preco=base/fator;
  if(pesoUsado>0&&freteMode==='dim'){renderTable(getPrecoIdx(preco));verificarFaixaFrete();}
  const vI=preco*pI,vC=preco*pC,vA=preco*pA,vM=preco*pM;
  const payout=preco-base-vI-vC-vA,markup=custo>0?preco/custo:0;
  const inv=custo*qtd,roi=inv>0?(payout*qtd/inv)*100:0;
  lastCalc={preco,base,pI,pC,pA,pM,custo,frete,ins,freteFullUnit,qtd,precoML,markup,roi,payout,inv};

  (function(){const el=document.getElementById('price-grid');if(el)el.style.gridTemplateColumns='1fr 1fr';})();
  const _tag1=document.querySelector('.price-card.calc .pc-tag'); if(_tag1)_tag1.textContent='Preço Ideal Calculado';
  const mainBadge=document.querySelector('.price-card.calc .pc-badge')||document.createElement('span');
  mainBadge.textContent='✅ Preço mínimo seguro';
  mainBadge.style.cssText='display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(74,222,128,.2);color:var(--in);font-size:.67rem;font-weight:700;margin-bottom:9px';
  (function(){const el=document.getElementById('pc-preco');if(el)el.textContent=fmt(preco);})();
  (function(){const el=document.getElementById('pc-mk');if(el)el.textContent=markup.toFixed(2).replace('.',',');})();
  (function(){const el=document.getElementById('pc-roi');if(el)el.textContent=fmtP(roi);})();
  (function(){const el=document.getElementById('pc-mg');if(el)el.textContent=fmtP(pM*100);})();

  const mlCard=document.getElementById('pc-ml-card');mlCard.style.display='block';
  if(precoML>0){
    const mlvI=precoML*pI,mlvC=precoML*pC,mlvA=precoML*pA;
    const mlPayout=precoML-base-mlvI-mlvC-mlvA;
    const mlMarkup=custo>0?precoML/custo:0,mlRoi=inv>0?(mlPayout*qtd/inv)*100:0,mlMargem=(mlPayout/precoML)*100;
    (function(){const el=document.getElementById('pc-ml-preco');if(el)el.textContent=fmt(precoML);})();
    (function(){const el=document.getElementById('ml-mk');if(el)el.textContent=mlMarkup.toFixed(2).replace('.',',');})();
    (function(){const el=document.getElementById('ml-roi');if(el)el.textContent=fmtP(mlRoi);})();
    (function(){const el=document.getElementById('ml-mg');if(el)el.textContent=fmtP(mlMargem);})();
    (function(){const el=document.getElementById('pc-ml-kpis');if(el)el.style.opacity='1';})();
    const diff=precoML-preco,pct=Math.abs((diff/preco)*100).toFixed(1);
    if(Math.abs(diff)<0.01){
      mlCard.className='price-card ml-equal';
      (function(){const el=document.getElementById('pc-ml-badge');if(el)el.style.cssText='display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(139,92,246,.25);color:#c4b5fd;font-size:.67rem;font-weight:700;margin-bottom:9px';})();
      (function(){const el=document.getElementById('pc-ml-badge');if(el)el.textContent='= Igual ao preço calculado';})();
      (function(){const el=document.getElementById('pc-ml-tag');if(el)el.textContent='💛 Preço Médio ML';})();
      (function(){const el=document.getElementById('explain-text');if(el)el.innerHTML=`Preço médio ML igual ao seu preço mínimo. Você pode vender nesse valor mantendo a margem definida.`;})();
    }else if(diff>0){
      mlCard.className='price-card ml-cheaper';
      (function(){const el=document.getElementById('pc-ml-badge');if(el)el.style.cssText='display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(74,222,128,.2);color:var(--in);font-size:.67rem;font-weight:700;margin-bottom:9px';})();
      (function(){const el=document.getElementById('pc-ml-badge');if(el)el.textContent=`✅ ${pct}% acima do seu mínimo`;})();
      (function(){const el=document.getElementById('pc-ml-tag');if(el)el.textContent='💛 Preço Médio ML';})();
      (function(){const el=document.getElementById('explain-text');if(el)el.innerHTML=`O mercado paga <strong style="color:var(--in)">${pct}% a mais</strong> que seu preço mínimo. Você pode ser mais competitivo ou vender no preço médio e aumentar a margem.`;})();
    }else{
      mlCard.className='price-card ml-pricier';
      (function(){const el=document.getElementById('pc-ml-badge');if(el)el.style.cssText='display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(239,68,68,.2);color:var(--out);font-size:.67rem;font-weight:700;margin-bottom:9px';})();
      (function(){const el=document.getElementById('pc-ml-badge');if(el)el.textContent=`⚠️ ${pct}% abaixo do seu mínimo`;})();
      (function(){const el=document.getElementById('pc-ml-tag');if(el)el.textContent='⚠️ Preço Médio ML';})();
      const custoIdeal=precoML*fator-frete-ins;
      (function(){const el=document.getElementById('explain-text');if(el)el.innerHTML=`Preço médio ML está <strong style="color:var(--out)">${pct}% abaixo</strong> do seu mínimo. Para vender a ${fmt(precoML)} com a mesma margem, compre por no máximo <strong style="color:var(--in)">${fmt(Math.max(custoIdeal,0))}</strong>.`;})();
    }
    (function(){const el=document.getElementById('bottom-wrapper');if(el)el.style.display='flex';})();
  }else{
    mlCard.className='price-card ml-none';
    (function(){const el=document.getElementById('pc-ml-preco');if(el)el.textContent='—';})();
    (function(){const el=document.getElementById('pc-ml-badge');if(el)el.style.cssText='display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(255,255,255,.08);color:var(--text2);font-size:.67rem;font-weight:700;margin-bottom:9px';})();
    (function(){const el=document.getElementById('pc-ml-badge');if(el)el.textContent='Informe o preço médio';})();
    (function(){const el=document.getElementById('pc-ml-kpis');if(el)el.style.opacity='.25';})();
    ['ml-mk','ml-roi','ml-mg'].forEach(id=>document.getElementById(id).textContent='—');
    (function(){const el=document.getElementById('explain-text');if(el)el.innerHTML=`Este é o menor preço que cobre todos os seus custos com a margem definida. Informe o <strong style="color:var(--o)">Preço Médio ML</strong> para ver o comparativo.`;})();
    (function(){const el=document.getElementById('bottom-wrapper');if(el)el.style.display='none';})();
  }

  const alertBox=document.getElementById('frete-alert-box');
  if(pesoUsado>0&&freteMode==='dim'){
    const piAtual=getPesoIdx(pesoUsado),ciAtual=getPrecoIdx(preco);
    let alerta=null;
    for(let ci=ciAtual-1;ci>=0;ci--){
      const freteNovo=T[piAtual][ci],limitePreco=precoFaixas[ci+1]-0.01;
      const baseNova=custo+freteNovo+ins,precoMinNovo=baseNova/fator;
      if(precoMinNovo<=limitePreco){alerta={freteNovo,limitePreco,ganhoFrete:frete-freteNovo};break;}
    }
    if(alerta){alertBox.style.display='block';(function(){const el=document.getElementById('frete-alert-content');if(el)el.innerHTML=`<div class="brow"><span class="bl">Frete atual</span><span class="br" style="color:var(--out)">${fmt(frete)}</span></div><div class="brow"><span class="bl">Frete vendendo até ${fmt(alerta.limitePreco)}</span><span class="br" style="color:var(--in)">${fmt(alerta.freteNovo)}</span></div><div class="brow total"><span class="bl">Economia</span><span class="br" style="color:var(--in)">${fmt(alerta.ganhoFrete)}</span></div><div style="margin-top:8px;font-size:.78rem;color:var(--text2)">Vendendo por até <strong style="color:var(--o)">${fmt(alerta.limitePreco)}</strong> seu frete cai <strong style="color:var(--in)">${fmt(alerta.ganhoFrete)}</strong>.</div>`;})();}
    else{alertBox.style.display='none';}
  }else{alertBox.style.display='none';}

  preencherDetalhes(custo,frete,ins,base,vI,vC,vA,vM,preco,payout,qtd,inv,vI*qtd);
  finalizarCalculo();
}

function preencherDetalhes(custo,frete,ins,base,vI,vC,vA,vM,preco,payout,qtd,inv,totalImp){
  (function(){const el=document.getElementById('bd-custo');if(el)el.textContent=fmt(custo);})();
  (function(){const el=document.getElementById('bd-frete');if(el)el.textContent=fmt(frete);})();
  const freteFullUnit=lastCalc&&lastCalc.freteFullUnit||0;
  const insSemFull=ins-freteFullUnit;
  const elBdFull=document.getElementById('bd-frete-full');
  const elBdFullRow=document.getElementById('bd-frete-full-row');
  if(elBdFull&&elBdFullRow){
    if(freteFullUnit>0){elBdFull.textContent=fmt(freteFullUnit);elBdFullRow.style.display='flex';}
    else{elBdFullRow.style.display='none';}
  }
  (function(){const el=document.getElementById('bd-outros');if(el)el.textContent=fmt(insSemFull>0?insSemFull:ins);})();
  (function(){const el=document.getElementById('bd-base');if(el)el.textContent=fmt(base);})();
  (function(){const el=document.getElementById('bd-imp');if(el)el.textContent=fmt(vI);})();
  (function(){const el=document.getElementById('bd-com');if(el)el.textContent=fmt(vC);})();
  (function(){const el=document.getElementById('bd-afi');if(el)el.textContent=fmt(vA);})();
  (function(){const el=document.getElementById('bd-mar');if(el)el.textContent=fmt(vM);})();
  (function(){const el=document.getElementById('bd-preco');if(el)el.textContent=fmt(preco);})();

  // Projeção — Preço Calculado
  (function(){const el=document.getElementById('proj-qtd');if(el)el.textContent=qtd;})();
  (function(){const el=document.getElementById('proj-cu');if(el)el.textContent=fmt(custo);})();
  (function(){const el=document.getElementById('proj-inv');if(el)el.textContent=fmt(inv);})();
  (function(){const el=document.getElementById('proj-imp');if(el)el.textContent=fmt(totalImp);})();
  (function(){const el=document.getElementById('proj-fat');if(el)el.textContent=fmt(preco*qtd);})();
  (function(){const el=document.getElementById('proj-pay');if(el)el.textContent=fmt(payout);})();
  // payout aqui = margem em R$ (já subtraiu custo+frete+ins)
  // Payout REAL ML = preco - totalImp(vI) - vC*preco - vA*preco = o que cai na conta
  // Como preencherDetalhes recebe vI,vC,vA e preco, calcular aqui:
  const elPD=document.getElementById('proj-payout-destaque');
  if(elPD){
    // Payout ML = preço - impostos - comissão ML - afiliados - frete entrega
    // O ML desconta todos esses do repasse antes de depositar
    // Payout ML = preço − comissão ML − afiliados − frete
    // Imposto (vI) NÃO é descontado pelo ML — é recolhido separadamente pelo vendedor
    const payoutReal=preco-vC-vA-frete;
    elPD.textContent=fmt(payoutReal);
    elPD.style.color=payoutReal>=0?'var(--text2)':'var(--out)';
  }
  (function(){const el=document.getElementById('proj-lb');if(el)el.textContent=fmt(payout*qtd);})();
  setTimeout(function(){ marcarAmarelo(['proj-lb']); },0);
  (function(){const el=document.getElementById('proj-cx-bruto');if(el)el.textContent=fmt(inv+payout*qtd+totalImp);})();
  (function(){const el=document.getElementById('proj-cx');if(el)el.textContent=fmt(inv+payout*qtd);})();

  // Projeção — Preço Médio ML (grid 3 colunas)
  const precoML=lastCalc&&lastCalc.precoML||0;
  const header=document.getElementById('proj-header-ml');
  const simple=document.getElementById('proj-simple');
  const double=document.getElementById('proj-double');

  if(precoML>0){
    const mlvI=precoML*(lastCalc.pI||0),mlvC=precoML*(lastCalc.pC||0),mlvA=precoML*(lastCalc.pA||0);
    const mlPayout=precoML-custo-frete-ins-mlvI-mlvC-mlvA;
    const mlImp=mlvI*qtd;

    if(header)header.style.display='block';
    if(simple)simple.style.display='none';
    if(double)double.style.display='block';

    const s=id=>document.getElementById(id);
    const set=(id,txt)=>{const el=s(id);if(el)el.textContent=txt;};
    // Coluna A — Preço Margem
    set('pd-cu-a',fmt(custo));
    set('pd-inv-a',fmt(inv));
    set('pd-imp-a',fmt(totalImp));
    set('pd-fat-a',fmt(preco*qtd));
    set('pd-pay-a',fmt(payout));
    set('pd-cx-bruto-a',fmt(inv+payout*qtd+totalImp));
    set('pd-cx-a',fmt(inv+payout*qtd));
    set('pd-lb-a',fmt(payout*qtd));
    // Coluna B — Preço Médio
    set('pd-cu-b',fmt(custo));
    set('pd-inv-b',fmt(inv));
    set('pd-imp-b',fmt(mlImp));
    set('pd-fat-b',fmt(precoML*qtd));
    const elPayB=s('pd-pay-b');
    if(elPayB){elPayB.textContent=fmt(mlPayout);elPayB.style.color=mlPayout>=0?'var(--text2)':'var(--out)';}
    set('pd-cx-bruto-b',fmt(inv+mlPayout*qtd+mlImp));
    set('pd-cx-b',fmt(inv+mlPayout*qtd));
    const elLbB=s('pd-lb-b');
    if(elLbB){elLbB.textContent=fmt(mlPayout*qtd);}
    setTimeout(function(){ marcarAmarelo(['pd-lb-a','pd-lb-b']); },0);
    // Payout destacado por cenário
    // Payout REAL ML = preço - comissões ML (o que cai na conta antes de pagar custos)
    // lastCalc.preco = preço calculado, payout da variável local = margem em R$ (já subtrai custo+frete)
    // Payout real cenário A = preco - vI - vC - vA
    // Payout real = preço - impostos - comissão - afiliados - frete
    const payoutRealA = preco - vC - vA - frete;
    // Cenário B usa o mesmo frete físico do produto
    const payoutRealB = precoML - mlvC - mlvA - frete;
    const elPA=s('pd-payout-destaque-a');
    if(elPA){elPA.textContent=fmt(payoutRealA);elPA.style.color=payoutRealA>=0?'var(--text2)':'var(--out)';}
    const elPB=s('pd-payout-destaque-b');
    if(elPB){elPB.textContent=fmt(payoutRealB);elPB.style.color=payoutRealB>=0?'var(--in)':'var(--out)';}
  }else{
    if(header)header.style.display='none';
    if(simple)simple.style.display='block';
    if(double)double.style.display='none';
  }
}

function finalizarCalculo(){
  (function(){const el=document.getElementById('right-empty');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('right-result');if(el)el.style.display='block';})();
  try{ renderResultadoHero(); }catch(e){ console.warn('hero:', e); }
  
  // Mostrar caixa de devolução
  if(lastCalc&&lastCalc.payout>0){
    calcDevolucao();
  }

  rolarParaResultado();
}

// Depois de calcular, leva a pessoa para o início do resultado.
// No celular (colunas empilhadas), rola a página inteira para o topo.
// No desktop (colunas lado a lado), rola só o painel de resultado.
function rolarParaResultado(){
  try{
    const ehMobile = window.innerWidth <= 900;
    if(ehMobile){
      const pagina = document.querySelector('#page-calc.active') || document.getElementById('page-calc');
      if(pagina) pagina.scrollIntoView({behavior:'smooth', block:'start'});
      window.scrollTo({top:0, behavior:'smooth'});
    }else{
      const painel = document.getElementById('right-result');
      if(painel) painel.scrollIntoView({behavior:'smooth', block:'start'});
    }
  }catch(e){ console.warn('rolarParaResultado:', e); }
}

function resetar(preservarEdicao){
  // Reseta modo edição — CRÍTICO: sem isso, salvar após "Novo Cálculo" atualiza o produto anterior.
  // Exceção: verNaCalculadora() chama resetar(true) só para limpar os campos antes de
  // repovoar com o snapshot do produto — nesse caso o modo edição não pode ser apagado,
  // senão "Atualizar produto" nunca mais funciona depois de abrir um produto salvo.
  if(!preservarEdicao){
    _prodEditId = null;
    const btnAtualizar = document.getElementById('btn-atualizar');
    const btnSalvar = document.getElementById('btn-salvar-prod');
    if(btnAtualizar) btnAtualizar.style.display = 'none';
    if(btnSalvar) btnSalvar.style.display = '';
  }
  // Limpa campos do save-card
  ['save-nome','save-forn','save-cod','save-obs','save-link1','save-link2','save-link3']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  // Fecha seção de links
  const linksDiv = document.getElementById('links-anuncio');
  if(linksDiv) linksDiv.style.display = 'none';

  // Limpa painel direito
  (function(){const el=document.getElementById('right-empty');if(el)el.style.display='flex';})();
  (function(){const el=document.getElementById('right-result');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('bottom-wrapper');if(el)el.style.display='none';})();

  // Custo dos produtos — reseta para 1 item vazio
  const list=document.getElementById('items-list');
  list.innerHTML='<div class="item-row"><input type="number" class="item-input" placeholder="Custo item 1 (R$)" min="0" step="0.01"><button class="remove-btn" onclick="removeItem(this)">×</button></div>';

  // Frete por dimensões
  ['peso','comp','larg','alt'].forEach(id=>{document.getElementById(id).value='';});
  (function(){const el=document.getElementById('peso-info');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('frete-section');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('frete-badge');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('frete-aviso');if(el)el.style.display='none';})();

  // Frete manual
  document.getElementById('frete-manual').value='';

  // Insumos e Full
  document.getElementById('insumos').value='';
  document.getElementById('frete-full').value='';
  document.getElementById('frete-full-qtd').value='';
  (function(){const el=document.getElementById('frete-full-result');if(el)el.style.display='none';})();
  // Reset toggle frete full
  _freteFullVisivel = false;
  const _panel = document.getElementById('frete-full-panel');
  const _tog = document.getElementById('toggle-frete-full');
  const _dot = document.getElementById('toggle-frete-full-dot');
  if(_panel) _panel.style.display='none';
  if(_tog) _tog.style.background='var(--border)';
  if(_dot) _dot.style.left='2px';

  // Taxas
  document.getElementById('impostos').value='';
  document.getElementById('comissao').value='';
  document.getElementById('afiliados').value='';
  document.getElementById('margem').value='';

  // Projeção
  document.getElementById('quantidade').value='';
  document.getElementById('preco-ml').value='';

  // Frete reverso e ranqueamento
  document.getElementById('dev-taxa').value='';
  document.getElementById('rank-preco').value='';
  document.getElementById('rank-qtd').value='';
  (function(){const el=document.getElementById('rank-resultado');if(el)el.style.display='none';})();

  // Reset variáveis globais
  pesoUsado=0;freteSel=0;freteSel_col=undefined;lastCalc=null;
}

// ID do produto sendo editado (null = novo produto)
let _prodEditId = null;

// Atualiza produto existente no dashboard
async function atualizarProduto(){
  if(!lastCalc||!_prodEditId) return;
  const nome=document.getElementById('save-nome').value.trim();
  if(!nome){alert('Informe o nome do produto.');return;}
  const fator=1-lastCalc.pI-lastCalc.pC-lastCalc.pA-lastCalc.pM;
  const custoIdeal=lastCalc.precoML>0&&lastCalc.precoML<lastCalc.preco?(lastCalc.precoML*fator-lastCalc.frete-lastCalc.ins):null;
  let margemML=null;
  if(lastCalc.precoML>0){
    const mlPayout=lastCalc.precoML-lastCalc.base-lastCalc.precoML*lastCalc.pI-lastCalc.precoML*lastCalc.pC-lastCalc.precoML*lastCalc.pA;
    margemML=(mlPayout/lastCalc.precoML)*100;
  }
  const snapshot={
    calcMode,itens:[...(document.querySelectorAll('.item-input')||[])].map(el=>parseFloat(el.value)||0).filter(v=>v>0),
    freteMode,freteSel,freteSel_col,freteManual:parseFloat(document.getElementById('frete-manual').value)||0,
    peso:parseFloat(document.getElementById('peso').value)||0,comp:parseFloat(document.getElementById('comp').value)||0,
    larg:parseFloat(document.getElementById('larg').value)||0,alt:parseFloat(document.getElementById('alt').value)||0,
    insumos:parseFloat(document.getElementById('insumos').value)||0,
    freteFullTotal:parseFloat(document.getElementById('frete-full').value)||0,freteFullQtd:parseInt(document.getElementById('frete-full-qtd').value)||1,
    impostos:parseFloat(document.getElementById('impostos').value)||0,comissao:parseFloat(document.getElementById('comissao').value)||0,
    afiliados:parseFloat(document.getElementById('afiliados').value)||0,margem:parseFloat(document.getElementById('margem').value)||0,
    quantidade:parseInt(document.getElementById('quantidade').value)||1,precoML:parseFloat(document.getElementById('preco-ml').value)||0,
  };
  const link1=document.getElementById('save-link1')?document.getElementById('save-link1').value.trim():'';
  const link2=document.getElementById('save-link2')?document.getElementById('save-link2').value.trim():'';
  const link3=document.getElementById('save-link3')?document.getElementById('save-link3').value.trim():'';

  const prods=await fbGet('produtos','realecom_prods','[]');
  const idx=prods.findIndex(p=>p.id===_prodEditId);
  if(idx===-1){alert('Produto não encontrado. Salve como novo.');return;}
  prods[idx]={...prods[idx],nome,forn:document.getElementById('save-forn').value.trim()||'—',cod:document.getElementById('save-cod').value.trim()||'—',obs:document.getElementById('save-obs').value.trim(),link1,link2,link3,custoReal:lastCalc.custo,custoIdeal,precoCalc:lastCalc.preco,precoML:lastCalc.precoML,markup:lastCalc.markup,roi:lastCalc.roi,margem:lastCalc.pM*100,margemML,payout:lastCalc.payout,frete:lastCalc.frete,ins:lastCalc.ins,pI:lastCalc.pI,pC:lastCalc.pC,pA:lastCalc.pA,snapshot};
  setCached('realecom_prods',prods);
  fbSet('produtos',prods);
  _prodEditId=null;
  (function(){const el=document.getElementById('btn-atualizar');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('btn-salvar-prod');if(el)el.style.display='';})();
  alert('✅ Produto atualizado no Dashboard!');
}

async function salvarProduto(){
  if(!lastCalc)return;
  const nome=document.getElementById('save-nome').value.trim();
  if(!nome){alert('Informe o nome do produto.');return;}
  const fator=1-lastCalc.pI-lastCalc.pC-lastCalc.pA-lastCalc.pM;
  const custoIdeal=lastCalc.precoML>0&&lastCalc.precoML<lastCalc.preco?(lastCalc.precoML*fator-lastCalc.frete-lastCalc.ins):null;

  // Captura todos os inputs para restaurar o cálculo depois
  const snapshot={
    calcMode,
    itens:[...(document.querySelectorAll('.item-input')||[])].map(el=>parseFloat(el.value)||0).filter(v=>v>0),
    freteMode,
    freteSel,
    freteSel_col,
    freteManual:parseFloat(document.getElementById('frete-manual').value)||0,
    peso:parseFloat(document.getElementById('peso').value)||0,
    comp:parseFloat(document.getElementById('comp').value)||0,
    larg:parseFloat(document.getElementById('larg').value)||0,
    alt:parseFloat(document.getElementById('alt').value)||0,
    insumos:parseFloat(document.getElementById('insumos').value)||0,
    freteFullTotal:parseFloat(document.getElementById('frete-full').value)||0,
    freteFullQtd:parseInt(document.getElementById('frete-full-qtd').value)||1,
    impostos:parseFloat(document.getElementById('impostos').value)||0,
    comissao:parseFloat(document.getElementById('comissao').value)||0,
    afiliados:parseFloat(document.getElementById('afiliados').value)||0,
    margem:parseFloat(document.getElementById('margem').value)||0,
    quantidade:parseInt(document.getElementById('quantidade').value)||1,
    precoML:parseFloat(document.getElementById('preco-ml').value)||0,
  };

  // Calcula margem no preço ML (se informado)
  let margemML = null;
  if(lastCalc.precoML>0){
    const mlPayout=lastCalc.precoML-lastCalc.base-lastCalc.precoML*lastCalc.pI-lastCalc.precoML*lastCalc.pC-lastCalc.precoML*lastCalc.pA;
    margemML=(mlPayout/lastCalc.precoML)*100;
  }
  const link1=document.getElementById('save-link1')?document.getElementById('save-link1').value.trim():'';
  const link2=document.getElementById('save-link2')?document.getElementById('save-link2').value.trim():'';
  const link3=document.getElementById('save-link3')?document.getElementById('save-link3').value.trim():'';
  const prod={id:Date.now(),nome,forn:document.getElementById('save-forn').value.trim()||'—',cod:document.getElementById('save-cod').value.trim()||'—',obs:document.getElementById('save-obs').value.trim(),link1,link2,link3,custoReal:lastCalc.custo,custoIdeal,precoCalc:lastCalc.preco,precoML:lastCalc.precoML,markup:lastCalc.markup,roi:lastCalc.roi,margem:lastCalc.pM*100,margemML,payout:lastCalc.payout,frete:lastCalc.frete,ins:lastCalc.ins,pI:lastCalc.pI,pC:lastCalc.pC,pA:lastCalc.pA,snapshot};
  // Lê do Firebase para não perder produtos salvos em outros dispositivos
  const prodsAtuais = await fbGet('produtos','realecom_prods','[]');
  prodsAtuais.unshift(prod);
  setCached('realecom_prods',prodsAtuais);
  fbSet('produtos', prodsAtuais);
  registrarAtividade('salvar_produto');
  document.getElementById('save-nome').value='';document.getElementById('save-forn').value='';document.getElementById('save-cod').value='';document.getElementById('save-obs').value='';
  if(document.getElementById('save-link1'))document.getElementById('save-link1').value='';
  if(document.getElementById('save-link2'))document.getElementById('save-link2').value='';
  if(document.getElementById('save-link3'))document.getElementById('save-link3').value='';
  _prodEditId=null;
  const btnUpdate=document.getElementById('btn-atualizar');
  if(btnUpdate)btnUpdate.style.display='none';
  (function(){const el=document.getElementById('btn-salvar-prod');if(el)el.style.display='';})();
  alert('✅ Produto salvo no Dashboard!');
}

async function salvarObs(id,val){
  const prods = await fbGet('produtos','realecom_prods','[]');
  const p=prods.find(p=>p.id===id);
  if(p){p.obs=val;setCached('realecom_prods',prods);fbSet('produtos',prods);}
}
async function deletarProduto(id){
  if(!confirm('Remover este produto?'))return;
  const prods = await fbGet('produtos','realecom_prods','[]');
  const prodsAtualizados = prods.filter(p=>p.id!==id);
  setCached('realecom_prods',prodsAtualizados);
  fbSet('produtos',prodsAtualizados);
  renderDash();
}
function toggleDetail(id){const det=document.getElementById('det-'+id);const btn=document.getElementById('tbtn-'+id);const open=det.style.display==='block';det.style.display=open?'none':'block';btn.textContent=open?'+ detalhes':'− fechar';}

async function renderDash(){
  const el=document.getElementById('dash-content');
  el.innerHTML='<div style="text-align:center;padding:44px;color:var(--text4);font-size:.8rem">Carregando…</div>';
  const prods=await fbGet('produtos','realecom_prods','[]');

  if(!prods.length){
    el.innerHTML='<div style="text-align:center;padding:60px 20px;color:var(--text4)">'
      +'<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="opacity:.4;margin-bottom:12px"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>'
      +'<div style="font-size:.85rem">Nenhum produto salvo ainda.</div>'
      +'<div style="font-size:.74rem;color:var(--text4);margin-top:5px">Faça um cálculo e salve para vê-lo aqui.</div></div>';
    return;
  }

  // margem: valor limpo, cor semântica. Sem pílula — a cor já diz.
  function mg(v){
    if(v===null||v===undefined||isNaN(v)) return '<span style="color:var(--text4);font-weight:500">—</span>';
    const c = v>=15 ? 'var(--in)' : v>=10 ? 'var(--text)' : 'var(--out)';
    return `<span style="color:${c};font-weight:700;font-size:.86rem">${fmtP(v)}</span>`;
  }

  function links(p){
    const ls=[p.link1,p.link2,p.link3].filter(l=>l&&l.trim());
    if(!ls.length) return '<span style="color:var(--text4);font-size:.72rem">—</span>';
    return ls.map((l,i)=>`<a href="${l}" target="_blank" title="${l}" style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border:1px solid var(--border);border-radius:5px;font-size:.66rem;color:var(--text3);text-decoration:none;white-space:nowrap;transition:all .15s" onmouseover="this.style.borderColor='var(--text3)';this.style.color='var(--text)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>${i+1}</a>`).join(' ');
  }

  const ico = {
    calc:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="11" x2="8" y2="11"/><line x1="12" y1="11" x2="12" y2="11"/><line x1="16" y1="11" x2="16" y2="11"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="12" y1="16" x2="12" y2="16"/></svg>',
    del :'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    star:'<svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.9"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    chev:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>'
  };
  window.dashToggle = window.dashToggle || function(id, ev){
    if(ev && ev.target.closest('button,a,textarea')) return;   // clique em ação não abre
    const r = document.getElementById('det2-'+id);
    if(!r) return;
    const abrindo = r.style.display !== 'table-row';
    r.style.display = abrindo ? 'table-row' : 'none';
    const c = document.getElementById('cv-'+id);
    if(c) c.style.transform = abrindo ? 'rotate(180deg)' : '';
  };

  const ib = 'background:none;border:1px solid transparent;border-radius:7px;padding:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s';

  const head=`<table style="width:100%;border-collapse:collapse">
    <thead><tr>
      <th style="padding:0 12px 9px 2px;text-align:left;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text4);border-bottom:1px solid var(--border)">Produto</th>
      <th style="padding:0 12px 9px;text-align:right;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text4);border-bottom:1px solid var(--border);white-space:nowrap">Margem calc.</th>
      <th style="padding:0 12px 9px;text-align:right;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text4);border-bottom:1px solid var(--border);white-space:nowrap">Margem ML</th>
      <th style="padding:0 12px 9px;text-align:left;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text4);border-bottom:1px solid var(--border)">Links</th>
      <th style="padding:0 2px 9px;text-align:right;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text4);border-bottom:1px solid var(--border)">Ações</th>
    </tr></thead><tbody>`;

  const rows=prods.map(p=>{
    const det='det2-'+p.id;
    const mlCalc = (p.margemML!==undefined&&p.margemML!==null) ? p.margemML
      : (p.precoML>0 ? ((p.precoML-p.custoReal-(p.frete||0)-(p.ins||0)-p.precoML*(p.pI||0)-p.precoML*(p.pC||0)-p.precoML*(p.pA||0))/p.precoML)*100 : null);
    const comp = p.comprado;

    return `<tr onclick="dashToggle(${p.id},event)" style="border-bottom:1px solid var(--border);cursor:pointer" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='transparent'">
      <td style="padding:11px 12px 11px 2px;vertical-align:middle">
        <div style="display:flex;align-items:center;gap:7px">
          <div style="font-size:.84rem;font-weight:600;color:var(--text);line-height:1.35;transition:color .15s" onmouseover="this.style.color='var(--mark)'" onmouseout="this.style.color='var(--text)'">${p.nome}</div>
          ${comp?'<span style="background:var(--in-bg);color:var(--in);border:1px solid var(--in-line);border-radius:20px;padding:1px 7px;font-size:.58rem;font-weight:600;white-space:nowrap;flex-shrink:0">comprado</span>':''}
        </div>
        <div style="font-size:.68rem;color:var(--text4);margin-top:3px">${p.forn} · ${p.cod}</div>
      </td>
      <td style="padding:11px 12px;text-align:right;vertical-align:middle;white-space:nowrap">${mg(p.margem)}</td>
      <td style="padding:11px 12px;text-align:right;vertical-align:middle;white-space:nowrap">${mg(mlCalc)}</td>
      <td style="padding:11px 12px;vertical-align:middle">${links(p)}</td>
      <td style="padding:11px 2px 11px 12px;vertical-align:middle">
        <div style="display:flex;gap:4px;align-items:center;justify-content:flex-end">
          <button onclick="verNaCalculadora(${p.id})" title="Abrir na calculadora" style="display:inline-flex;align-items:center;gap:5px;background:var(--card);border:1px solid var(--border);border-radius:7px;padding:6px 11px;cursor:pointer;font-size:.7rem;font-weight:600;color:var(--text);white-space:nowrap;font-family:inherit;transition:all .15s" onmouseover="this.style.borderColor='var(--mark)';this.style.background='var(--mark-soft)'" onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--card)'">${ico.calc} Cálculo</button>
          <button onclick="toggleComprado(${p.id})" title="${comp?'Desmarcar compra':'Marcar como comprado'}" style="${ib};color:${comp?'var(--in)':'var(--text3)'};fill:${comp?'var(--in)':'none'};background:${comp?'var(--in-bg)':'none'};border-color:${comp?'var(--in-line)':'transparent'}" onmouseover="this.style.borderColor='var(--in-line)';this.style.color='var(--in)'" onmouseout="this.style.borderColor='${comp?'var(--in-line)':'transparent'}';this.style.color='${comp?'var(--in)':'var(--text3)'}'">${ico.star}</button>
          <button onclick="deletarProduto(${p.id})" title="Remover produto" style="${ib};color:var(--text3)" onmouseover="this.style.color='var(--out)';this.style.borderColor='var(--out)'" onmouseout="this.style.color='var(--text3)';this.style.borderColor='transparent'">${ico.del}</button>
          <button id="cv-${p.id}" onclick="dashToggle(${p.id})" title="Ver detalhes" style="${ib};color:var(--text3);transition:transform .2s,color .15s,border-color .15s" onmouseover="this.style.color='var(--text)';this.style.borderColor='var(--border)'" onmouseout="this.style.color='var(--text3)';this.style.borderColor='transparent'">${ico.chev}</button>
        </div>
      </td>
    </tr>
    <tr id="${det}" style="display:none">
      <td colspan="5" style="padding:4px 2px 18px;border-bottom:1px solid var(--border)">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:18px;margin-bottom:16px">
          <div><div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:4px">Preço calc.</div><div style="font-size:.9rem;font-weight:600">${fmt(p.precoCalc)}</div></div>
          <div><div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:4px">Preço médio ML</div><div style="font-size:.9rem;font-weight:600">${p.precoML>0?fmt(p.precoML):'—'}</div></div>
          <div><div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:4px">Custo real</div><div style="font-size:.9rem;font-weight:600;color:var(--out)">${fmt(p.custoReal)}</div></div>
          <div><div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:4px">Custo ideal</div><div style="font-size:.9rem;font-weight:600;color:${p.custoIdeal!==null&&p.custoIdeal>0?'var(--in)':'var(--text4)'}">${p.custoIdeal!==null?fmt(Math.max(p.custoIdeal,0)):'—'}</div></div>
          <div><div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:4px">Lucro/unid.</div><div style="font-size:.9rem"><span class="mk-dash" data-v="${p.payout}">${fmt(p.payout)}</span></div></div>
        </div>
        <div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:6px">Observações</div>
        <textarea class="prod-obs" onchange="salvarObs(${p.id},this.value)" placeholder="Anotações…">${p.obs||''}</textarea>
      </td>
    </tr>`;
  }).join('');

  el.innerHTML=head+rows+'</tbody></table>';

  const comp=prods.filter(p=>p.comprado).length;
  const comMg=prods.filter(p=>p.margem!==undefined&&p.margem!==null&&!isNaN(p.margem));
  const mgMedia=comMg.length?comMg.reduce(function(s,p){return s+parseFloat(p.margem);},0)/comMg.length:null;
  const st=function(id,v){const e=document.getElementById(id);if(e)e.textContent=v;};
  st('dash-st-total',prods.length);
  st('dash-st-comp',comp);
  st('dash-st-mg',mgMedia!==null?fmtP(mgMedia):'—');

  // marca-texto no lucro por unidade
  const css=getComputedStyle(document.documentElement);
  const bg=css.getPropertyValue('--mark').trim(), fg=css.getPropertyValue('--mark-fg').trim();
  el.querySelectorAll('.mk-dash').forEach(function(s){
    s.style.setProperty('background',bg,'important');
    s.style.setProperty('color',fg,'important');
    s.style.setProperty('-webkit-text-fill-color',fg,'important');
    s.style.cssText+=';padding:2px 8px;border-radius:5px;font-weight:700;display:inline-block';
  });
}

// ============================================================
// SAZONALIDADE
// ============================================================
const DATAS_SAZONAIS = [
  // 2026
  {id:'volta_aulas_jan_26', titulo:'Volta às Aulas — Janeiro', data:'2026-01-15', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z\"/><path d=\"M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z\"/></svg></span>', cor:'#2563eb'},
  {id:'carnaval_26',        titulo:'Carnaval',                 data:'2026-03-01', dias:[30,15],    icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#db2777,#9d174d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg></span>', cor:'#db2777'},
  {id:'pascoa_26',          titulo:'Páscoa',                   data:'2026-04-05', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#d97706,#b45309);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"5\"/><line x1=\"12\" y1=\"1\" x2=\"12\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"23\"/><line x1=\"4.22\" y1=\"4.22\" x2=\"5.64\" y2=\"5.64\"/><line x1=\"18.36\" y1=\"18.36\" x2=\"19.78\" y2=\"19.78\"/><line x1=\"1\" y1=\"12\" x2=\"3\" y2=\"12\"/><line x1=\"21\" y1=\"12\" x2=\"23\" y2=\"12\"/><line x1=\"4.22\" y1=\"19.78\" x2=\"5.64\" y2=\"18.36\"/><line x1=\"18.36\" y1=\"5.64\" x2=\"19.78\" y2=\"4.22\"/></svg></span>', cor:'#d97706'},
  {id:'maes_26',            titulo:'Dia das Mães',             data:'2026-05-11', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#ec4899,#be185d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg></span>', cor:'#ec4899'},
  {id:'namorados_26',       titulo:'Dia dos Namorados',        data:'2026-06-12', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#f43f5e,#e11d48);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg></span>', cor:'#f43f5e'},
  {id:'inverno_26',         titulo:'Início do Inverno',        data:'2026-06-21', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#0891b2,#0e7490);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"12\" y1=\"2\" x2=\"12\" y2=\"22\"/><path d=\"M17 7l-5-5-5 5\"/><path d=\"M17 17l-5 5-5-5\"/><line x1=\"2\" y1=\"12\" x2=\"22\" y2=\"12\"/><path d=\"M7 7l-5 5 5 5\"/><path d=\"M17 7l5 5-5 5\"/></svg></span>', cor:'#0891b2'},
  {id:'volta_aulas_jul_26', titulo:'Volta às Aulas — Julho',   data:'2026-07-01', dias:[30,15],    icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 20V10a8 8 0 0 1 16 0v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z\"/><path d=\"M9 20v-5a3 3 0 0 1 6 0v5\"/><line x1=\"8\" y1=\"10\" x2=\"16\" y2=\"10\"/></svg></span>', cor:'#7c3aed'},
  {id:'pais_26',            titulo:'Dia dos Pais',             data:'2026-08-09', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44z\"/><path d=\"M10.59 4.59l.6 3.4-3.4-.6z\"/></svg></span>', cor:'#16a34a'},
  {id:'criancas_26',        titulo:'Dia das Crianças',         data:'2026-10-12', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#6B21A8,#9333ea);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg></span>', cor:'#6B21A8'},
  {id:'verao_26',           titulo:'Início do Verão',          data:'2026-09-21', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#F0A070,#ea580c);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"5\"/><line x1=\"12\" y1=\"1\" x2=\"12\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"23\"/><line x1=\"4.22\" y1=\"4.22\" x2=\"5.64\" y2=\"5.64\"/><line x1=\"18.36\" y1=\"18.36\" x2=\"19.78\" y2=\"19.78\"/><line x1=\"1\" y1=\"12\" x2=\"3\" y2=\"12\"/><line x1=\"21\" y1=\"12\" x2=\"23\" y2=\"12\"/><line x1=\"4.22\" y1=\"19.78\" x2=\"5.64\" y2=\"18.36\"/><line x1=\"18.36\" y1=\"5.64\" x2=\"19.78\" y2=\"4.22\"/></svg></span>', cor:'var(--text2)'},
  {id:'blackfriday_26',     titulo:'Black Friday',             data:'2026-11-27', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#4a3f6b,#2d2460);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"12\" y1=\"1\" x2=\"12\" y2=\"23\"/><path d=\"M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6\"/></svg></span>', cor:'#4a3f6b'},
  {id:'natal_26',           titulo:'Natal',                    data:'2026-12-25', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg></span>', cor:'#16a34a'},
  // 2027
  {id:'volta_aulas_jan_27', titulo:'Volta às Aulas — Janeiro', data:'2027-01-15', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z\"/><path d=\"M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z\"/></svg></span>', cor:'#2563eb'},
  {id:'carnaval_27',        titulo:'Carnaval',                 data:'2027-02-14', dias:[30,15],    icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#db2777,#9d174d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg></span>', cor:'#db2777'},
  {id:'pascoa_27',          titulo:'Páscoa',                   data:'2027-03-28', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#d97706,#b45309);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"5\"/><line x1=\"12\" y1=\"1\" x2=\"12\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"23\"/><line x1=\"4.22\" y1=\"4.22\" x2=\"5.64\" y2=\"5.64\"/><line x1=\"18.36\" y1=\"18.36\" x2=\"19.78\" y2=\"19.78\"/><line x1=\"1\" y1=\"12\" x2=\"3\" y2=\"12\"/><line x1=\"21\" y1=\"12\" x2=\"23\" y2=\"12\"/><line x1=\"4.22\" y1=\"19.78\" x2=\"5.64\" y2=\"18.36\"/><line x1=\"18.36\" y1=\"5.64\" x2=\"19.78\" y2=\"4.22\"/></svg></span>', cor:'#d97706'},
  {id:'maes_27',            titulo:'Dia das Mães',             data:'2027-05-09', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#ec4899,#be185d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg></span>', cor:'#ec4899'},
  {id:'namorados_27',       titulo:'Dia dos Namorados',        data:'2027-06-12', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#f43f5e,#e11d48);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg></span>', cor:'#f43f5e'},
  {id:'inverno_27',         titulo:'Início do Inverno',        data:'2027-06-21', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#0891b2,#0e7490);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"12\" y1=\"2\" x2=\"12\" y2=\"22\"/><path d=\"M17 7l-5-5-5 5\"/><path d=\"M17 17l-5 5-5-5\"/><line x1=\"2\" y1=\"12\" x2=\"22\" y2=\"12\"/><path d=\"M7 7l-5 5 5 5\"/><path d=\"M17 7l5 5-5 5\"/></svg></span>', cor:'#0891b2'},
  {id:'volta_aulas_jul_27', titulo:'Volta às Aulas — Julho',   data:'2027-07-01', dias:[30,15],    icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 20V10a8 8 0 0 1 16 0v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z\"/><path d=\"M9 20v-5a3 3 0 0 1 6 0v5\"/><line x1=\"8\" y1=\"10\" x2=\"16\" y2=\"10\"/></svg></span>', cor:'#7c3aed'},
  {id:'pais_27',            titulo:'Dia dos Pais',             data:'2027-08-08', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44z\"/><path d=\"M10.59 4.59l.6 3.4-3.4-.6z\"/></svg></span>', cor:'#16a34a'},
  {id:'criancas_27',        titulo:'Dia das Crianças',         data:'2027-10-12', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#6B21A8,#9333ea);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg></span>', cor:'#6B21A8'},
  {id:'verao_27',           titulo:'Início do Verão',          data:'2027-09-21', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#F0A070,#ea580c);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"5\"/><line x1=\"12\" y1=\"1\" x2=\"12\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"23\"/><line x1=\"4.22\" y1=\"4.22\" x2=\"5.64\" y2=\"5.64\"/><line x1=\"18.36\" y1=\"18.36\" x2=\"19.78\" y2=\"19.78\"/><line x1=\"1\" y1=\"12\" x2=\"3\" y2=\"12\"/><line x1=\"21\" y1=\"12\" x2=\"23\" y2=\"12\"/><line x1=\"4.22\" y1=\"19.78\" x2=\"5.64\" y2=\"18.36\"/><line x1=\"18.36\" y1=\"5.64\" x2=\"19.78\" y2=\"4.22\"/></svg></span>', cor:'var(--text2)'},
  {id:'blackfriday_27',     titulo:'Black Friday',             data:'2027-11-26', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#4a3f6b,#2d2460);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"12\" y1=\"1\" x2=\"12\" y2=\"23\"/><path d=\"M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6\"/></svg></span>', cor:'#4a3f6b'},
  {id:'natal_27',           titulo:'Natal',                    data:'2027-12-25', dias:[45,30,15], icon:'<span style=\"width:32px;height:32px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg></span>', cor:'#16a34a'},
];

function verificarSazonalidade(){
  renderSazonalGrid();
  showPage('sazonal', true);
}

function toggleSazonal(id){
  const selecionados = getCached('realecom_sazonal_sel','[]');
  const idx = selecionados.indexOf(id);
  if(idx>=0) selecionados.splice(idx,1);
  else selecionados.push(id);
  setCached('realecom_sazonal_sel', selecionados);
  renderSazonalGrid();
}

function renderSazonalGrid(){
  const el = document.getElementById('sazonal-grid');
  if(!el) return;
  const selecionados = getCached('realecom_sazonal_sel','[]');
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const titulosVistos = new Set();
  const datasFuturas = DATAS_SAZONAIS
    .filter(d => new Date(d.data + 'T00:00:00') >= hoje)
    .filter(d => {
      if(titulosVistos.has(d.titulo)) return false;
      titulosVistos.add(d.titulo);
      return true;
    })
    .sort((a,b) => a.data.localeCompare(b.data));

  el.innerHTML = datasFuturas.map(d => {
    const dataEv = new Date(d.data + 'T00:00:00');
    const sel = selecionados.includes(d.id);
    const diasRestantes = Math.round((dataEv - hoje) / (1000*60*60*24));
    const dataFmt = d.data.split('-').reverse().join('/');
    return '<div onclick="toggleSazonal(\'' + d.id + '\')" data-id="' + d.id + '" style="background:var(--card);border:2px solid ' + (sel?d.cor+'88':'var(--border)') + ';border-radius:12px;padding:12px 14px;cursor:pointer;user-select:none;transition:all .2s;' + (sel?'background:'+d.cor+'12':'') + '">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="pointer-events:none;display:flex">' + d.icon + '</span>' +
        '<div style="flex:1;pointer-events:none">' +
          '<div style="font-size:.82rem;font-weight:700;color:var(--text)">' + d.titulo + '</div>' +
          '<div style="font-size:.68rem;color:var(--text3)">' + dataFmt + ' · em ' + diasRestantes + ' dias</div>' +
        '</div>' +
        '<div style="width:20px;height:20px;border-radius:50%;border:2px solid ' + (sel?d.cor:'var(--border)') + ';background:' + (sel?d.cor:'none') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;pointer-events:none;transition:all .2s">' +
          (sel?'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  const count = document.getElementById('sazonal-count');
  if(count) count.textContent = selecionados.filter(id=>datasFuturas.some(d=>d.id===id)).length + ' selecionadas';
}
function selecionarTodasSazonais(sel){
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const titulosVistos = new Set();
  const datasFuturas = DATAS_SAZONAIS.filter(d=>{
    const dataEv = new Date(d.data+'T00:00:00');
    if(dataEv < hoje) return false;
    if(titulosVistos.has(d.titulo)) return false;
    titulosVistos.add(d.titulo);
    return true;
  }).map(d=>d.id);
  setCached('realecom_sazonal_sel', sel?datasFuturas:[]);
  renderSazonalGrid();
}

function salvarSazonalidade(){
  const selecionados = getCached('realecom_sazonal_sel','[]');
  if(!selecionados.length){
    if(!confirm('Nenhuma data selecionada. Deseja salvar assim mesmo?')) return;
  }

  const hoje = new Date(); hoje.setHours(0,0,0,0);

  // Remove lembretes sazonais futuros existentes antes de recriar
  let evs = getEventos().filter(e=>{
    if(e.tipo!=='sazonal') return true;
    const dataEv = new Date(e.data+'T00:00:00');
    return dataEv < hoje; // mantém passados
  });

  let criados = 0;

  selecionados.forEach(id => {
    const d = DATAS_SAZONAIS.find(x=>x.id===id);
    if(!d) return;
    const dataEv = new Date(d.data + 'T00:00:00');
    if(dataEv < hoje) return;

    // Evento principal no dia
    evs.push({
      id: Date.now()+Math.random(),
      titulo: d.titulo,
      tipo: 'sazonal',
      data: d.data,
      hora: '',
      obs: 'Data sazonal — planejamento de estoque',
      push: true,
      sazonalId: d.id
    });
    criados++;

    // Lembretes de antecedência
    d.dias.forEach((diasAntes, i) => {
      const dataLembrete = new Date(dataEv.getTime() - diasAntes*24*60*60*1000);
      if(dataLembrete < hoje) return;
      const dataStr = dataLembrete.toISOString().split('T')[0];
      evs.push({
        id: Date.now()+Math.random()+i,
        titulo: `${d.titulo} em ${diasAntes} dias`,
        tipo: 'sazonal',
        data: dataStr,
        hora: '09:00',
        obs: `Faltam ${diasAntes} dias para ${d.titulo}. Você vai participar desta data?`,
        push: true,
        sazonalId: d.id,
        lembrete: true,
        diasAntes
      });
      criados++;
    });
  });

  saveEventos(evs);

  if(Notification.permission==='granted') agendarTodasNotificacoes();

  alert(`✅ ${criados} lembretes criados no calendário!`);
  showPage('cal');
}

// Verificar se há notificação de confirmação de sazonalidade pendente
function verificarConfirmacoesSazonais(){
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const notificados = JSON.parse(sessionStorage.getItem('sazonal_notif')||'[]');

  getEventos().filter(e=>e.tipo==='sazonal'&&e.lembrete).forEach(ev=>{
    const dataEv = new Date(ev.data+'T00:00:00');
    const diff = Math.round((dataEv-hoje)/(1000*60*60*24));
    if(diff!==0) return;
    if(notificados.includes(ev.id)) return;

    // Mostra notificação in-app perguntando se vai participar
    setTimeout(()=>{
      mostrarNotifSazonal(ev);
      notificados.push(ev.id);
      sessionStorage.setItem('sazonal_notif', JSON.stringify(notificados));
    }, 2000);
  });
}

function mostrarNotifSazonal(ev){
  const d = DATAS_SAZONAIS.find(x=>x.id===ev.sazonalId);
  const container = document.getElementById('notif-container');
  const div = document.createElement('div');
  div.className='notif outro';
  div.style.borderColor='var(--text2)';
  div.style.maxWidth='340px';
  div.innerHTML=`
    <div class="notif-body" style="width:100%">
      <div class="notif-title" style="color:var(--text2);margin-bottom:4px">${ev.titulo.replace(/ em \d+ dias/,'')}</div>
      <div class="notif-sub" style="margin-bottom:10px">${ev.obs}</div>
      <div style="display:flex;gap:8px">
        <button onclick="confirmarSazonal('sim','${ev.sazonalId}',this)" style="flex:1;padding:6px;background:#16a34a22;border:1px solid #16a34a55;color:var(--in);border-radius:7px;font-size:.72rem;font-weight:700;cursor:pointer">✅ Sim, vou participar</button>
        <button onclick="confirmarSazonal('nao','${ev.sazonalId}',this)" style="flex:1;padding:6px;background:#7f1d1d22;border:1px solid #ef444455;color:var(--out);border-radius:7px;font-size:.72rem;font-weight:700;cursor:pointer">❌ Não vou participar</button>
      </div>
    </div>
    <button class="notif-close" onclick="this.parentElement.remove()">×</button>`;
  container.appendChild(div);
}

function confirmarSazonal(resp, sazonalId, btn){
  const notif = btn.closest('.notif');
  if(resp==='nao'){
    // Remove todos os lembretes futuros desta sazonalidade
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const evs = getEventos().filter(e=>{
      if(e.sazonalId!==sazonalId) return true;
      const dataEv = new Date(e.data+'T00:00:00');
      return dataEv <= hoje; // mantém passados, remove futuros
    });
    saveEventos(evs);
    // Remove da lista de selecionados
    const sel = getCached('realecom_sazonal_sel','[]').filter(x=>x!==sazonalId);
    setCached('realecom_sazonal_sel', sel);
    if(notif) notif.remove();
    mostrarNotifMsg({tipo:'outro',data:''}, '✅ Lembretes removidos para esta data.', 1);
  } else {
    if(notif) notif.remove();
    mostrarNotifMsg({tipo:'outro',data:''}, '🚀 Ótimo! Verifique seu calendário para se preparar.', 1);
  }
}

// ============================================================
// ============================================================
let _swRegistration = null;

async function inicializarPush(){
  if(!PUSH_ATIVO) return;
  if(!('serviceWorker' in navigator)||!('Notification' in window)) return;
  try{
    _swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    atualizarBtnPush();
  }catch(e){ console.warn('SW registro falhou:', e); }
}

function atualizarBtnPush(){ calChips(); }


async function solicitarPermissaoNotificacao(){
  if(!PUSH_ATIVO) return;
  if(!('Notification' in window)){alert('Seu navegador não suporta notificações.');return;}
  if(Notification.permission === 'granted'){alert('Notificações já estão ativas!');return;}
  if(Notification.permission === 'denied'){alert('Notificações estão bloqueadas. Vá em Configurações do navegador → Privacidade → Notificações e permita este site.');return;}
  const perm = await Notification.requestPermission();
  atualizarBtnPush();
  if(perm === 'granted'){
    new Notification('RealEcom', {body:'Notificações ativadas! Você receberá lembretes dos seus eventos.', icon:'/logcon.png'});
    // Agenda notificações dos eventos existentes
    agendarTodasNotificacoes();
  }
}

function agendarNotificacao(titulo, corpo, dataHora, tag){
  if(Notification.permission !== 'granted') return;
  const agora = Date.now();
  const quando = dataHora instanceof Date ? dataHora.getTime() : dataHora;
  const delay = quando - agora;
  if(delay <= 0) return; // já passou
  if(delay > 7 * 24 * 60 * 60 * 1000) return; // mais de 7 dias, não agenda (limite do SW)
  setTimeout(()=>{
    if(Notification.permission === 'granted'){
      new Notification('RealEcom — ' + titulo, {body: corpo, icon:'/logcon.png', tag});
    }
  }, delay);
}

function agendarNotificacoesEvento(ev){
  if(Notification.permission !== 'granted') return;
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const dataEv = new Date(ev.data + 'T00:00:00');
  const diffDias = Math.round((dataEv - hoje) / (1000*60*60*24));

  // Regras por tipo
  let diasAntes = [];
  if(ev.tipo === 'full'){
    diasAntes = [5,4,3,2,1];
  } else if(ev.titulo === 'Pagamento DAS'){
    diasAntes = [1];
  } else if(ev.tipo === 'giro_pedido' || ev.tipo === 'giro_entrega'){
    diasAntes = [3,2,1];
  } else {
    diasAntes = [1];
  }

  // Agenda notificações de antecedência
  diasAntes.forEach(d => {
    if(diffDias === d){
      const msg = d === 1 ? `Amanhã: ${ev.titulo}` : `Em ${d} dias: ${ev.titulo}`;
      agendarNotificacao(ev.titulo, msg, new Date(hoje.getTime() + 9*60*60*1000), `${ev.id}_${d}d`);
    }
  });

  // No dia — manhã (9h) e tarde (15h)
  if(diffDias === 0){
    agendarNotificacao(ev.titulo, `Hoje: ${ev.titulo}${ev.obs?' — '+ev.obs:''}`, new Date(hoje.getTime() + 9*60*60*1000), `${ev.id}_manha`);
    agendarNotificacao(ev.titulo, `Lembrete tarde: ${ev.titulo}`, new Date(hoje.getTime() + 15*60*60*1000), `${ev.id}_tarde`);
  }
}

function agendarTodasNotificacoes(){
  getEventos().forEach(ev => agendarNotificacoesEvento(ev));
}

// ============================================================
// CALENDÁRIO — TEMPLATES
// ============================================================
const templatesEvento = {
  das:        {titulo:'Pagamento DAS', tipo:'conta', obs:'Vencimento mensal do DAS - Simples Nacional'},
  full:       {titulo:'Coleta Full', tipo:'full', obs:''},
  cartao:     {titulo:'Pagar Cartão', tipo:'conta', obs:''},
  estoque:    {titulo:'Ver Estoque', tipo:'outro', obs:'Conferir nível de estoque'},
  fornecedor: {titulo:'Pedido ao Fornecedor', tipo:'entrega', obs:''},
};

function abrirModalTemplate(tipo){
  const t = templatesEvento[tipo];
  if(!t) return;
  // Usa a data já preenchida no modal (dia clicado) ou hoje como fallback
  const dataAtual = document.getElementById('ev-data').value || new Date().toISOString().split('T')[0];
  abrirModal(dataAtual);
  setTimeout(()=>{
    document.getElementById('ev-titulo').value = t.titulo;
    document.getElementById('ev-tipo').value = t.tipo;
    document.getElementById('ev-obs').value = t.obs;
    document.getElementById('ev-push').checked = true;
  }, 50);
}

// Também expor como aplicarTemplate para compatibilidade com modal
function aplicarTemplate(tipo){ abrirModalTemplate(tipo); }

// ============================================================
// CALENDÁRIO
// ============================================================
const tipoInfo={full:{icon:'📦',label:'Coleta Full',cls:'full'},conta:{icon:'💰',label:'Vencimento de Conta',cls:'conta'},entrega:{icon:'🚚',label:'Entrega',cls:'entrega'},outro:{icon:'📌',label:'Outro',cls:'outro'},sazonal:{icon:'📅',label:'Data Sazonal',cls:'sazonal'},giro_pedido:{icon:'🛒',label:'Pedido Giro',cls:'outro'},giro_entrega:{icon:'📦',label:'Entrega Giro',cls:'entrega'}};
const diasSemana=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const meses=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
function getEventos(){return getCached('realecom_eventos','[]');}
function saveEventos(evs){setCached('realecom_eventos',evs);fbSet('eventos',evs);}
function navMes(dir){calMes+=dir;if(calMes>11){calMes=0;calAno++;}if(calMes<0){calMes=11;calAno--;}renderCal();}

// Cores por tipo para pills — dark mode
const tipoCores={
  full:        {bg:'#7c3aed18',color:'var(--text2)',dot:'#7c3aed'},
  conta:       {bg:'#dc262618',color:'var(--out)',dot:'#dc2626'},
  entrega:     {bg:'#16a34a18',color:'var(--in)',dot:'#16a34a'},
  outro:       {bg:'#F0A07018',color:'var(--text2)',dot:'var(--text2)'},
  sazonal:     {bg:'#d9770618',color:'var(--text2)',dot:'#d97706'},
  giro_pedido: {bg:'#7c3aed18',color:'var(--text2)',dot:'#7c3aed'},
  giro_entrega:{bg:'#16a34a18',color:'var(--in)',dot:'#16a34a'},
};

// Cores por tipo para pills — light mode
const tipoCoresLight={
  full:        {bg:'#ede9fe',color:'#5b21b6',dot:'#7c3aed'},
  conta:       {bg:'#fee2e2',color:'#b91c1c',dot:'#dc2626'},
  entrega:     {bg:'#dcfce7',color:'#15803d',dot:'#16a34a'},
  outro:       {bg:'#fff7ed',color:'#c2410c',dot:'#ea580c'},
  sazonal:     {bg:'#fef3c7',color:'#92400e',dot:'#d97706'},
  giro_pedido: {bg:'#ede9fe',color:'#5b21b6',dot:'#7c3aed'},
  giro_entrega:{bg:'#dcfce7',color:'#15803d',dot:'#16a34a'},
};

function getTipoCores(tipo){
  const isLight = document.body.classList.contains('light');
  const mapa = isLight ? tipoCoresLight : tipoCores;
  return mapa[tipo] || (isLight ? {bg:'#f3f4f6',color:'#374151',dot:'#6b7280'} : tipoCores.outro);
}

function nomesCurto(titulo){
  const mapa={
    'Pagamento DAS':'DAS','Coleta Full':'Coleta Full','Pagar Cartão':'Cartão',
    'Ver Estoque':'Estoque','Pedido ao Fornecedor':'Fornecedor',
    'Fazer pedido ao fornecedor':'Pedido','Chegada do novo lote':'Lote',
    'Volta às Aulas — Janeiro':'Volta Aulas','Volta às Aulas — Julho':'Volta Aulas',
    'Carnaval':'Carnaval','Páscoa':'Páscoa','Dia das Mães':'Dia das Mães',
    'Dia dos Namorados':'Namorados','Início do Inverno':'Inverno',
    'Dia dos Pais':'Dia dos Pais','Início do Verão':'Verão',
    'Dia das Crianças':'Crianças','Black Friday':'Black Friday','Natal':'Natal',
  };
  if(mapa[titulo]) return mapa[titulo];
  const base=titulo.replace(/ em \d+ dias?$/,'');
  if(mapa[base]) return mapa[base];
  return titulo.length>12?titulo.substring(0,11)+'…':titulo;
}

function renderCal(){
  (function(){const el=document.getElementById('cal-titulo');if(el)el.textContent=`${meses[calMes]} ${calAno}`;})();
  calStats();
  calChips();
  const grid=document.getElementById('cal-grid');
  const eventos=getEventos();
  const hoje=new Date();
  const primeiroDia=new Date(calAno,calMes,1).getDay();
  const diasNoMes=new Date(calAno,calMes+1,0).getDate();
  let h='';
  diasSemana.forEach(d=>h+=`<div class="cal-day-header">${d}</div>`);
  for(let i=0;i<primeiroDia;i++){
    const d=new Date(calAno,calMes,0).getDate()-primeiroDia+i+1;
    h+=`<div class="cal-day other-month" style="height:82px"><div class="day-num">${d}</div></div>`;
  }
  for(let d=1;d<=diasNoMes;d++){
    const dataStr=`${calAno}-${String(calMes+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isHoje=hoje.getFullYear()===calAno&&hoje.getMonth()===calMes&&hoje.getDate()===d;
    const evsDia=eventos.filter(e=>e.data===dataStr);
    const max=3;
    let pillsHtml=evsDia.slice(0,max).map(e=>{
      const tipo=e.tipo||(e.titulo==='Pagamento DAS'?'conta':'outro');
      const c=getTipoCores(tipo);
      const nome=nomesCurto(e.titulo);
      return `<div onclick="event.stopPropagation();abrirModal('${dataStr}',${e.id})" title="${e.titulo}" style="display:flex;align-items:center;gap:3px;background:${c.bg};border-radius:4px;padding:2px 5px;margin-top:2px;cursor:pointer;overflow:hidden"><span style="width:5px;height:5px;border-radius:50%;background:${c.dot};flex-shrink:0"></span><span style="font-size:.6rem;color:${c.color};font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nome}</span></div>`;
    }).join('');
    if(evsDia.length>max) pillsHtml+=`<div style="font-size:.58rem;color:var(--text3);padding-left:3px;margin-top:1px">+${evsDia.length-max}</div>`;
    h+=`<div class="cal-day${isHoje?' today':''}" onclick="abrirModal('${dataStr}')" style="height:82px;overflow:hidden"><div class="day-num">${d}</div>${pillsHtml}</div>`;
  }
  const total=primeiroDia+diasNoMes;
  const resto=total%7===0?0:7-(total%7);
  for(let i=1;i<=resto;i++) h+=`<div class="cal-day other-month" style="height:82px"><div class="day-num">${i}</div></div>`;
  grid.innerHTML=h;
}

function abrirModal(data,evId){
  evEditId=evId||null;
  const ev=evId?getEventos().find(e=>e.id===evId):null;
  document.getElementById('ev-data').value=ev?ev.data:(data||'');
  document.getElementById('ev-titulo').value=ev?ev.titulo:'';
  document.getElementById('ev-hora').value=ev?ev.hora:'';
  document.getElementById('ev-obs').value=ev?ev.obs:'';
  document.getElementById('ev-local').value=ev?(ev.local||''):'';
  document.getElementById('ev-tipo').value=ev?ev.tipo:'full';
  document.getElementById('ev-push').checked=ev?!!ev.push:true;
  (function(){const el=document.getElementById('modal-title');if(el)el.textContent=ev?'✏️ Editar Evento':(data?`📅 Novo Evento — ${data.split('-').reverse().join('/')}`:'📅 Novo Evento');})();
  let btnDel=document.getElementById('btn-del-ev');
  if(!btnDel){
    btnDel=document.createElement('button');btnDel.id='btn-del-ev';btnDel.className='btn-cancel';
    btnDel.style.cssText='background:#ff3b3018;border-color:#ff3b3055;color:var(--out);margin-right:auto';
    btnDel.textContent='🗑 Excluir';btnDel.onclick=()=>excluirEvento();
    document.querySelector('.modal-btns').prepend(btnDel);
  }
  btnDel.style.display=ev?'block':'none';
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(()=>document.getElementById('ev-titulo').focus(),100);
}

function salvarEvento(){
  const titulo=document.getElementById('ev-titulo').value.trim();
  if(!titulo){alert('Informe o título do evento.');return;}
  const evs=getEventos();
  const novoEv={
    titulo,
    tipo:document.getElementById('ev-tipo').value,
    data:document.getElementById('ev-data').value,
    hora:document.getElementById('ev-hora').value,
    obs:document.getElementById('ev-obs').value.trim(),
    local:document.getElementById('ev-local').value.trim(),
    push:document.getElementById('ev-push').checked
  };
  if(evEditId){
    const idx=evs.findIndex(e=>e.id===evEditId);
    if(idx>=0)evs[idx]={...evs[idx],...novoEv};
  }else{
    novoEv.id=Date.now();
    evs.push(novoEv);
  }
  saveEventos(evs);
  // Agenda notificação push se ativado
  if(novoEv.push){
    if(Notification.permission==='granted'){
      agendarNotificacoesEvento(novoEv.id?novoEv:{...novoEv,id:evs[evs.length-1].id});
    }else if(Notification.permission!=='denied'){
      solicitarPermissaoNotificacao();
    }
  }
  fecharModal();renderCal();
}

function fecharModal(){document.getElementById('modal-overlay').classList.remove('open');evEditId=null;}

function excluirEvento(){
  if(!evEditId)return;
  if(!confirm('Excluir este evento?'))return;
  saveEventos(getEventos().filter(e=>e.id!==evEditId));
  fecharModal();renderCal();
}

document.getElementById('modal-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('modal-overlay'))fecharModal();});

// NOTIFICAÇÕES
const msgFull={5:'📦 Coleta Full em 5 dias! Vai enviar? Se não for presta atenção na data limite de cancelamento!',4:'📦 Coleta Full em 4 dias! Se for alterar a data presta atenção para não tomar multa!',3:'📦 Coleta Full em 3 dias! Já conferiu todos os produtos do envio? Olha lá!',2:'📦 Coleta Full em 2 dias! Etiquetou tudo? Não esquece de cobrir o cód. de barras eim!',1:'📦 Coleta Full amanhã!',0:'📦 Hoje é o dia da Coleta Full! Não esquece a Autorização de Entrada e a Nota de Remessa!'};

function mostrarNotifMsg(ev,mensagem,diffDias){
  const container=document.getElementById('notif-container');
  const ti=tipoInfo[ev.tipo];
  const urgencia=diffDias===0?'var(--out)':diffDias===1?'var(--text2)':'var(--text2)';
  const div=document.createElement('div');div.className=`notif ${ev.tipo}`;div.style.borderColor=urgencia;
  div.innerHTML=`<div class="notif-icon">${ti.icon}</div><div class="notif-body"><div class="notif-title" style="color:${urgencia}">${mensagem}</div><div class="notif-sub">${ev.data.split('-').reverse().join('/')}${ev.hora?' às '+ev.hora:''}${ev.obs?' — '+ev.obs:''}</div></div><button class="notif-close" onclick="this.parentElement.remove()">×</button>`;
  container.appendChild(div);
  setTimeout(()=>{if(div.parentElement)div.remove();},8000);
}

function garantirDAS(){
  // Garante que existe evento DAS no dia 20 de cada mês (próximos 12 meses)
  const evs=getEventos();
  const hoje=new Date();
  let alterado=false;

  for(let i=0;i<12;i++){
    const d=new Date(hoje.getFullYear(),hoje.getMonth()+i,20);
    const dataStr=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-20`;
    const jaExiste=evs.some(e=>e.data===dataStr&&e.titulo==='Pagamento DAS');
    if(!jaExiste){
      evs.push({id:Date.now()+i,titulo:'Pagamento DAS',tipo:'conta',data:dataStr,hora:'',obs:'Vencimento mensal do DAS - Simples Nacional'});
      alterado=true;
    }
  }
  if(alterado)saveEventos(evs);
}

function verificarNotificacoes(){
  garantirDAS();
  const hoje=new Date();hoje.setHours(0,0,0,0);
  const notificados=JSON.parse(sessionStorage.getItem('notificados')||'[]');
  getEventos().forEach(ev=>{
    const dataEv=new Date(ev.data+'T00:00:00');
    const diffDias=Math.round((dataEv-hoje)/(1000*60*60*24));
    const chave=`${ev.id}_${diffDias}`;
    if(notificados.includes(chave))return;
    // DAS: notifica nos 5 dias anteriores e no dia
    if(ev.titulo==='Pagamento DAS'&&diffDias>=0&&diffDias<=5){
      const msgs={0:'💰 Hoje é o vencimento do DAS! Não esqueça de pagar.',1:'💰 DAS vence amanhã! Já separou o valor?',2:'💰 DAS vence em 2 dias.',3:'💰 DAS vence em 3 dias.',4:'💰 DAS vence em 4 dias.',5:'💰 DAS vence em 5 dias.'};
      setTimeout(()=>mostrarNotifMsg(ev,msgs[diffDias],diffDias),800);
      notificados.push(chave);
    } else if(ev.tipo==='full'&&diffDias>=0&&diffDias<=5){
      setTimeout(()=>mostrarNotifMsg(ev,msgFull[diffDias],diffDias),800);notificados.push(chave);
    } else if(ev.tipo!=='full'&&ev.titulo!=='Pagamento DAS'&&(diffDias===0||diffDias===1)){
      const ti=tipoInfo[ev.tipo];const msg=diffDias===0?`${ti.icon} Hoje: ${ev.titulo}!`:`${ti.icon} Amanhã: ${ev.titulo}!`;
      setTimeout(()=>mostrarNotifMsg(ev,msg,diffDias),800);notificados.push(chave);
    }
  });
  sessionStorage.setItem('notificados',JSON.stringify(notificados));
}

// Permite scroll mesmo com input numérico em foco — só bloqueia scroll dentro do input
document.addEventListener('wheel',e=>{
  if(document.activeElement&&document.activeElement.type==='number'){
    document.activeElement.blur();
  }
},{passive:true});
verificarNotificacoes();

function exportarExcel(){
  const prods=getCached('realecom_prods','[]');
  if(!prods.length){alert('Nenhum produto no Dashboard para exportar.');return;}

  const fmt2=(v)=>typeof v==='number'?v.toFixed(2).replace('.',','):v||'';

  // Cabeçalho
  const rows=[
    ['Nome','Fornecedor','Código','Custo Real (R$)','Custo Ideal (R$)','Preço Calculado (R$)','Preço Médio ML (R$)','Lucro/unid. (R$)','Markup','ROI (%)','Margem (%)','Observações']
  ];

  prods.forEach(p=>{
    rows.push([
      p.nome||'',
      p.forn||'',
      p.cod||'',
      fmt2(p.custoReal),
      p.custoIdeal!==null?fmt2(Math.max(p.custoIdeal,0)):'',
      fmt2(p.precoCalc),
      p.precoML>0?fmt2(p.precoML):'',
      fmt2(p.payout),
      p.markup?p.markup.toFixed(2).replace('.',','):'',
      fmt2(p.roi),
      fmt2(p.margem),
      p.obs||''
    ]);
  });

  // Gerar CSV com separador ; (compatível com Excel BR)
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const bom='\uFEFF'; // BOM para Excel reconhecer UTF-8
  const blob=new Blob([bom+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`dashboard_realecom_${new Date().toLocaleDateString('pt-BR').replace(/\//g,'-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// DASHBOARD — toggleComprado
// ============================================================
async function toggleComprado(id){
  const prods = await fbGet('produtos','realecom_prods','[]');
  const p=prods.find(p=>p.id===id);
  if(p){p.comprado=!p.comprado;setCached('realecom_prods',prods);fbSet('produtos',prods);renderDash();}
}

// ============================================================
// VER NA CALCULADORA — restaura o cálculo salvo
// ============================================================
function verNaCalculadora(id){
  const prods=getCached('realecom_prods','[]');
  const p=prods.find(p=>p.id===id);
  if(!p){alert('Produto não encontrado.');return;}

  // Ativa modo edição
  _prodEditId=id;

  const s=p.snapshot;

  // Navega para a calculadora primeiro
  showPage('calc', true);

  // Preenche campos do save-card com dados do produto
  setTimeout(()=>{
   try{
    if(document.getElementById('save-nome'))document.getElementById('save-nome').value=p.nome||'';
    if(document.getElementById('save-forn'))document.getElementById('save-forn').value=p.forn||'';
    if(document.getElementById('save-cod'))document.getElementById('save-cod').value=p.cod||'';
    if(document.getElementById('save-obs'))document.getElementById('save-obs').value=p.obs||'';
    if(document.getElementById('save-link1'))document.getElementById('save-link1').value=p.link1||'';
    if(document.getElementById('save-link2'))document.getElementById('save-link2').value=p.link2||'';
    if(document.getElementById('save-link3'))document.getElementById('save-link3').value=p.link3||'';
    // Abre seção de links se houver algum preenchido
    if((p.link1||p.link2||p.link3)&&document.getElementById('links-anuncio')){
      (function(){const el=document.getElementById('links-anuncio');if(el)el.style.display='flex';})();
    }
    // Mostra botão atualizar e esconde salvar
    const btnAtualizar=document.getElementById('btn-atualizar');
    const btnSalvar=document.getElementById('btn-salvar-prod');
    if(btnAtualizar)btnAtualizar.style.display='';
    if(btnSalvar)btnSalvar.style.display='none';
   }catch(e){ console.error('verNaCalculadora (save-card):', e); }
  },200);

  // Pequeno delay para garantir que a página renderizou
  setTimeout(()=>{
   try{
    // Reseta tudo antes de preencher, SEM apagar o modo edição que acabamos de ativar
    resetar(true);

    if(!s){
      // Produto antigo sem snapshot — preenche só o que temos
      const list=document.getElementById('items-list');
      list.innerHTML=`<div class="item-row"><input type="number" class="item-input" placeholder="Custo item 1 (R$)" min="0" step="0.01" value="${p.custoReal||0}"><button class="remove-btn" onclick="removeItem(this)">×</button></div>`;
      if(p.frete)document.getElementById('frete-manual').value=p.frete;
      switchFrete('manual');
      if(p.pI)document.getElementById('impostos').value=(p.pI*100).toFixed(2);
      if(p.pC)document.getElementById('comissao').value=(p.pC*100).toFixed(2);
      if(p.pA)document.getElementById('afiliados').value=(p.pA*100).toFixed(2);
      if(p.margem)document.getElementById('margem').value=p.margem.toFixed(2);
      if(p.precoML)document.getElementById('preco-ml').value=p.precoML;
      setMode(1);
      calcular();
      return;
    }

    // Restaura modo
    setMode(s.calcMode||1);

    // Restaura itens de custo
    const list=document.getElementById('items-list');
    const itens=s.itens&&s.itens.length?s.itens:[p.custoReal||0];
    list.innerHTML='';
    itens.forEach((v,i)=>{
      const d=document.createElement('div');d.className='item-row';
      d.innerHTML=`<input type="number" class="item-input" placeholder="Custo item ${i+1} (R$)" min="0" step="0.01" value="${v}"><button class="remove-btn" onclick="removeItem(this)" style="display:${itens.length>1?'flex':'none'}">×</button>`;
      list.appendChild(d);
    });

    // Restaura frete
    switchFrete(s.freteMode||'dim');
    if(s.freteMode==='manual'){
      document.getElementById('frete-manual').value=s.freteManual||0;
    }else{
      if(s.peso)document.getElementById('peso').value=s.peso;
      if(s.comp)document.getElementById('comp').value=s.comp;
      if(s.larg)document.getElementById('larg').value=s.larg;
      if(s.alt)document.getElementById('alt').value=s.alt;
      if(s.peso||s.comp)calcPeso();
      // Restaura seleção da faixa de frete se existia
      if(s.freteSel&&s.freteSel_col!==undefined){
        setTimeout(()=>selFrete(s.freteSel_col, s.freteSel), 100);
      }
    }

    // Restaura insumos e Full
    if(s.insumos)document.getElementById('insumos').value=s.insumos;
    if(s.freteFullTotal){
      toggleFreteFullVisivel(); // abre o painel
      document.getElementById('frete-full').value=s.freteFullTotal;
      if(s.freteFullQtd&&s.freteFullQtd>1)document.getElementById('frete-full-qtd').value=s.freteFullQtd;
      calcFreteFullUnit();
    }

    // Restaura taxas
    if(s.impostos)document.getElementById('impostos').value=s.impostos;
    if(s.comissao)document.getElementById('comissao').value=s.comissao;
    if(s.afiliados)document.getElementById('afiliados').value=s.afiliados;
    if(s.margem)document.getElementById('margem').value=s.margem;

    // Restaura projeção
    if(s.quantidade&&s.quantidade>1)document.getElementById('quantidade').value=s.quantidade;
    if(s.precoML)document.getElementById('preco-ml').value=s.precoML;

    // Executa o cálculo
    calcular();

   }catch(e){
    console.error('verNaCalculadora (cálculo):', e);
    const linha = (e.stack||'').split('\n').map(l=>l.trim()).find(l=>l.includes('app.js'));
    mostrarErroTela('Erro ao carregar o produto na calculadora. ' + (e.message||'') + (linha?' — ['+linha.replace(/^at\s*/,'')+']':''));
   }
  }, 100);
}

// ============================================================
// GESTÃO DE ESTOQUE — CALCULADORA DE GIRO
// ============================================================

function calcularGestao(){} // chamado no showPage, giro roda via oninput

function calcularGiro(){
  const qtd       = parseInt(document.getElementById('giro-qtd').value)||0;
  const valor     = parseMasked(document.getElementById('giro-valor'));
  const vendasDia = parseInt(document.getElementById('giro-vendas-dia').value)||0;
  const dataCompraStr  = document.getElementById('giro-data-compra').value;
  const dataInicioStr  = document.getElementById('giro-data-inicio').value;
  const prazo          = parseInt(document.getElementById('giro-prazo').value)||0;

  const resultado = document.getElementById('giro-resultado');
  const empty     = document.getElementById('giro-empty');

  if(!qtd||!vendasDia){resultado.style.display='none';empty.style.display='block';return;}

  resultado.style.display='block';
  empty.style.display='none';

  const custoUnit = qtd>0&&valor>0 ? valor/qtd : 0;
  const hoje = new Date(); hoje.setHours(0,0,0,0);

  // Dias de venda = desde o início das vendas (ou data de compra se não informado)
  let diasComp = 0;
  const dataRefStr = dataInicioStr || dataCompraStr;
  if(dataRefStr){
    const dataRef = new Date(dataRefStr+'T00:00:00');
    diasComp = Math.max(Math.round((hoje - dataRef)/(1000*60*60*24)), 0);
  }

  const jaVendido = Math.min(diasComp * vendasDia, qtd);
  const estoqueAtual = Math.max(qtd - jaVendido, 0);
  const diasRestantes = Math.floor(estoqueAtual / vendasDia);
  const fmtN = n => n.toLocaleString('pt-BR');

  (function(){const el=document.getElementById('giro-estoque-atual');if(el)el.textContent=fmtN(estoqueAtual);})();
  const hs=document.getElementById('giro-head-stats'); if(hs) hs.style.display='flex';
  const sh=function(id,v){const e=document.getElementById(id); if(e) e.textContent=v;};
  sh('hd-estoque', fmtN(estoqueAtual)+' un');
  sh('hd-dias', diasRestantes+(diasRestantes===1?' dia':' dias'));
  sh('hd-custo', custoUnit>0?fmt(custoUnit):'—');
  const elDias = document.getElementById('giro-dias-restantes');
  elDias.textContent = diasRestantes;
  elDias.style.color = prazo>0&&diasRestantes<=prazo ? 'var(--out)' : diasRestantes<=10 ? 'var(--text)' : 'var(--in)';
  (function(){const el=document.getElementById('giro-custo-unit');if(el)el.textContent=custoUnit>0 ? fmt(custoUnit) : '—';})();

  const alerta = document.getElementById('giro-alerta');
  if(prazo>0&&diasRestantes<=prazo){
    alerta.style.cssText='background:transparent;border:1px solid var(--out);border-radius:9px;padding:10px 13px;font-size:.78rem;color:var(--out);font-weight:600';
    alerta.textContent=`⚠️ Atenção! Seu estoque acaba em ${diasRestantes} dias mas o novo lote chega em ${prazo} dias. Faça o pedido agora!`;
  }else if(prazo>0&&diasRestantes<=prazo*1.5){
    alerta.style.cssText='background:var(--mark-soft);border:1px solid var(--mark);border-radius:9px;padding:10px 13px;font-size:.78rem;color:var(--text);font-weight:600';
    alerta.textContent=`⏳ Fique de olho — você tem ${diasRestantes} dias de estoque. Prepare-se para pedir em breve.`;
  }else{
    alerta.style.cssText='background:var(--in-bg);border:1px solid var(--in-line);border-radius:9px;padding:10px 13px;font-size:.78rem;color:var(--in);font-weight:600';
    alerta.textContent=`✅ Estoque tranquilo por ${diasRestantes} dias.`;
  }

  function cenario(d){const q=vendasDia*d;return{qtd:q,valor:q*custoUnit};}
  const c5=cenario(5),c10=cenario(10),c15=cenario(15),c30=cenario(30);
  (function(){const el=document.getElementById('giro-c5-qtd');if(el)el.textContent=fmtN(c5.qtd)+' unid.';})();
  (function(){const el=document.getElementById('giro-c5-val');if(el)el.textContent=custoUnit>0?fmt(c5.valor):'—';})();
  (function(){const el=document.getElementById('giro-c10-qtd');if(el)el.textContent=fmtN(c10.qtd)+' unid.';})();
  (function(){const el=document.getElementById('giro-c10-val');if(el)el.textContent=custoUnit>0?fmt(c10.valor):'—';})();
  (function(){const el=document.getElementById('giro-c15-qtd');if(el)el.textContent=fmtN(c15.qtd)+' unid.';})();
  (function(){const el=document.getElementById('giro-c15-val');if(el)el.textContent=custoUnit>0?fmt(c15.valor):'—';})();
  (function(){const el=document.getElementById('giro-c30-qtd');if(el)el.textContent=fmtN(c30.qtd)+' unid.';})();
  (function(){const el=document.getElementById('giro-c30-val');if(el)el.textContent=custoUnit>0?fmt(c30.valor):'—';})();

  const pontoRep = prazo>0 ? vendasDia*prazo : 0;
  (function(){const el=document.getElementById('giro-ponto-rep');if(el)el.textContent=fmtN(pontoRep);})();

  const btnCal  = document.getElementById('btn-add-cal');
  const elData  = document.getElementById('giro-ponto-data');
  const elMsg   = document.getElementById('giro-ponto-msg');
  const elLabel = document.getElementById('giro-ponto-label');

  if(prazo>0){
    const diasAtePonto = Math.max(Math.floor((estoqueAtual-pontoRep)/vendasDia),0);
    const dataPedido = new Date(hoje);
    dataPedido.setDate(dataPedido.getDate()+diasAtePonto);
    const dataPedidoStr = dataPedido.toISOString().split('T')[0];
    const dataPedidoFmt = dataPedido.toLocaleDateString('pt-BR');
    // Data de entrega = data do pedido + prazo em dias
    const dataEntrega = new Date(dataPedido);
    dataEntrega.setDate(dataEntrega.getDate()+prazo);
    const dataEntregaStr = dataEntrega.toISOString().split('T')[0];
    const dataEntregaFmt = dataEntrega.toLocaleDateString('pt-BR');
    elData.innerHTML = '<span id="giro-data-mk">'+dataPedidoFmt+'</span>';
    const dm=document.getElementById('giro-data-mk');
    if(dm){
      const cs=getComputedStyle(document.documentElement);
      dm.style.setProperty('background',cs.getPropertyValue('--mark').trim(),'important');
      dm.style.setProperty('color',cs.getPropertyValue('--mark-fg').trim(),'important');
      dm.style.setProperty('-webkit-text-fill-color',cs.getPropertyValue('--mark-fg').trim(),'important');
      dm.style.cssText+=';padding:3px 10px;border-radius:6px;display:inline-block;font-weight:700';
    }
    elLabel.textContent = diasAtePonto===0 ? '🔴 Peça HOJE!' : `em ${diasAtePonto} dias`;
    if(estoqueAtual<=pontoRep){
      elMsg.textContent=`Seu estoque já está no ponto de reposição. Faça o pedido agora! O lote chegaria em ${dataEntregaFmt}.`;
    }else{
      elMsg.textContent=`Em ${dataPedidoFmt} faça o pedido. O lote chegará em ${dataEntregaFmt} com estoque suficiente.`;
    }
    btnCal.style.display='block';
    btnCal.dataset.data = dataPedidoStr;
    btnCal.dataset.dataEntrega = dataEntregaStr;
    btnCal.textContent = '📅 Adicionar lembrete no Calendário';
    btnCal.disabled = false;
    btnCal.style.opacity = '1';
  }else{
    elData.textContent='—';
    elLabel.textContent='informe os dias do fornecedor';
    elMsg.textContent='Informe quantos dias o fornecedor demora para entregar para calcular quando fazer o pedido.';
    if(btnCal)btnCal.style.display='none';
  }
}

function adicionarGiroCalendario(){
  const btn = document.getElementById('btn-add-cal');
  const dataPedido   = btn.dataset.data;
  const dataEntrega  = btn.dataset.dataEntrega;
  if(!dataPedido) return;
  const evs = getEventos();
  const pedidoEv = {id:Date.now(), titulo:'🛒 Fazer pedido ao fornecedor', tipo:'giro_pedido', data:dataPedido, hora:'09:00', obs:'Ponto de reposição atingido — hora de pedir o novo lote', push:true};
  const entregaEv = dataEntrega ? {id:Date.now()+1, titulo:'📦 Chegada do novo lote', tipo:'giro_entrega', data:dataEntrega, hora:'', obs:'Entrega prevista do fornecedor', push:true} : null;
  evs.push(pedidoEv);
  if(entregaEv) evs.push(entregaEv);
  saveEventos(evs);
  if(Notification.permission==='granted'){
    agendarNotificacoesEvento(pedidoEv);
    if(entregaEv) agendarNotificacoesEvento(entregaEv);
  }
  btn.textContent='✅ Adicionado ao Calendário!';
  btn.disabled=true;
  btn.style.opacity='0.7';
  setTimeout(()=>{if(confirm('Eventos adicionados! Deseja ir ao Calendário agora?'))showPage('cal');},300);
}


// Máscara monetária R$ para inputs de texto
function maskReal(el){
  let v=el.value.replace(/\D/g,'');
  if(!v){el.value='';return;}
  v=(parseInt(v)/100).toFixed(2);
  el.value='R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function parseMasked(el){
  return parseFloat((el.value||'').replace(/[R$\s.]/g,'').replace(',','.'))||0;
}

// ============================================================
// CALCULADORA DE PUBLICIDADE — ROAS/ACOS
// ============================================================
let pubMode = 'dash'; // 'dash' ou 'manual'

function switchPubMode(mode){
  pubMode = mode;
  const btnDash = document.getElementById('pub-btn-dash');
  const btnMan  = document.getElementById('pub-btn-manual');
  const secDash = document.getElementById('pub-sec-dash');
  const secMan  = document.getElementById('pub-sec-manual');
  if(mode==='dash'){
    btnDash.style.background='linear-gradient(135deg,#6B21A8,#F0A070)';
    btnDash.style.color='#fff';
    btnMan.style.background='none';
    btnMan.style.color='var(--text3)';
    secDash.style.display='block';
    secMan.style.display='none';
    carregarProdutosPublicidade();
  }else{
    btnMan.style.background='linear-gradient(135deg,#6B21A8,#F0A070)';
    btnMan.style.color='#fff';
    btnDash.style.background='none';
    btnDash.style.color='var(--text3)';
    secDash.style.display='none';
    secMan.style.display='block';
    calcularPublicidadeManual();
  }
}

async function carregarProdutosPublicidade(){
  const prods = getCached('realecom_prods','[]');
  const sel = document.getElementById('pub-produto-sel');
  if(!sel) return;
  if(!prods.length){
    sel.innerHTML='<option value="">Nenhum produto salvo ainda</option>';
    return;
  }
  sel.innerHTML='<option value="">Selecione um produto...</option>'+
    prods.map((p,i)=>`<option value="${i}">${p.nome} — ${p.precoCalc?'R$ '+p.precoCalc.toLocaleString('pt-BR',{minimumFractionDigits:2}):'—'}</option>`).join('');
  sel.onchange = ()=>selecionarProdutoPublicidade(prods);
}

function selecionarProdutoPublicidade(prods){
  const idx = document.getElementById('pub-produto-sel').value;
  const preview = document.getElementById('pub-preview');
  const lucroEl = document.getElementById('pub-lucro-dash');
  if(idx===''){preview.style.display='none';(function(){const el=document.getElementById('pub-resultado');if(el)el.style.display='none';})();return;}
  const p = prods[parseInt(idx)];
  preview.style.display='grid';
  (function(){const el=document.getElementById('pub-pre-custo');if(el)el.textContent=fmt(p.custoReal||0);})();
  (function(){const el=document.getElementById('pub-pre-preco');if(el)el.textContent=fmt(p.precoCalc||0);})();
  (function(){const el=document.getElementById('pub-pre-margem');if(el)el.textContent=(p.margem||0).toFixed(1)+'%';})();
  (function(){const el=document.getElementById('pub-pre-payout');if(el)el.textContent=fmt(p.payout||0);})();
  if(lucroEl) lucroEl.value = '';
  calcularPublicidadeDash(p);
}

function calcularPublicidadeDash(p){
  const lucroDesejado = parseFloat(document.getElementById('pub-lucro-dash').value)||0;
  if(!p||!p.precoCalc) return;
  const taxaFrete = (p.frete||0) + (p.ins||0);
  const pI = p.pI||0, pC = p.pC||0, pA = p.pA||0;
  const custos = p.custoReal + taxaFrete + p.precoCalc*(pI+pC+pA);
  const margemAds = p.precoCalc - custos - (p.precoCalc*(lucroDesejado/100));
  renderResultadoPublicidade(p.precoCalc, margemAds);
}

function calcularPublicidadeManual(){
  const preco    = parseFloat(document.getElementById('pub-m-preco').value)||0;
  const custo    = parseFloat(document.getElementById('pub-m-custo').value)||0;
  const taxafrete= parseFloat(document.getElementById('pub-m-taxa').value)||0;
  const comissao = (parseFloat(document.getElementById('pub-m-comissao').value)||0)/100;
  const imposto  = (parseFloat(document.getElementById('pub-m-imposto').value)||0)/100;
  const lucro    = (parseFloat(document.getElementById('pub-m-lucro').value)||0)/100;
  if(!preco||!custo){(function(){const el=document.getElementById('pub-resultado');if(el)el.style.display='none';})();return;}
  const custos = custo + taxafrete + preco*(comissao+imposto);
  const margemAds = preco - custos - (preco*lucro);
  renderResultadoPublicidade(preco, margemAds);
}

function renderResultadoPublicidade(preco, margemAds){
  const res = document.getElementById('pub-resultado');
  let alerta = document.getElementById('pub-alerta');
  if(!alerta){
    alerta = document.createElement('div');
    alerta.id = 'pub-alerta';
    alerta.style.cssText = 'background:#7f1d1d22;border:1px solid #ef444455;border-radius:10px;padding:10px 14px;font-size:.78rem;color:var(--out);margin-top:8px;line-height:1.5;display:none';
    res.parentNode.insertBefore(alerta, res);
  }
  if(margemAds<=0||preco<=0){
    res.style.display='none';
    alerta.style.display='block';
    if(margemAds<=0 && preco>0){
      alerta.textContent='⚠️ A margem que você quer garantir é igual ou maior que a margem do produto — não sobra nada para investir em anúncios. Reduza a margem desejada ou melhore o custo do produto.';
    } else {
      alerta.textContent='Preencha o preço e o custo do produto para calcular.';
    }
    return;
  }
  alerta.style.display='none';
  res.style.display='block';
  const acos = (margemAds/preco)*100;
  const roas = preco/margemAds;
  // Guarda contra valores absurdos (margemAds quase zero)
  if(!isFinite(roas)||roas>9999||acos<0.01){
    res.style.display='none';
    const al = document.getElementById('pub-alerta');
    if(al){al.style.display='block';al.textContent='⚠️ A margem que você quer garantir é igual ou maior que a margem do produto — não sobra nada para investir em anúncios. Reduza a margem desejada ou melhore o custo do produto.';}
    return;
  }
  const ph=document.getElementById('pub-head-stats'); if(ph) ph.style.display='flex';
  const ps=function(id,v){const e=document.getElementById(id); if(e) e.textContent=v;};
  ps('hd-pub-roas', roas.toFixed(1)+'x');
  ps('hd-pub-acos', acos.toFixed(1)+'%');
  ps('hd-pub-verba', fmt(margemAds));
  (function(){const el=document.getElementById('pub-roas');if(el)el.textContent=roas.toFixed(1)+'x';})();
  (function(){const el=document.getElementById('pub-acos');if(el)el.textContent=acos.toFixed(1)+'%';})();
  (function(){const el=document.getElementById('pub-margem-ads');if(el)el.textContent=fmt(margemAds);})();
  pintarMarca('pub-margem-ads');
  (function(){const el=document.getElementById('pub-exp-roas');if(el)el.textContent=fmt(preco);})();
  (function(){const el=document.getElementById('pub-exp-acos');if(el)el.textContent=acos.toFixed(1)+'%';})();
  (function(){const el=document.getElementById('pub-exp-margem');if(el)el.textContent=fmt(margemAds);})();
  // Mostra campo de nome só no modo manual
  const nomeWrap=document.getElementById('pub-save-nome-wrap');
  if(nomeWrap) nomeWrap.style.display=pubMode==='manual'?'block':'none';
}

function toggleGlossario(){
  const body=document.getElementById('glossario-body');
  const arrow=document.getElementById('glossario-arrow');
  const open=body.style.display==='block';
  body.style.display=open?'none':'block';
  if(arrow)arrow.textContent=open?'▼':'▲';
}

function salvarAnalisePublicidade(){
  const roas=(document.getElementById('pub-roas')||{}).textContent||'—';
  const acos=(document.getElementById('pub-acos')||{}).textContent||'—';
  const margem=(document.getElementById('pub-margem-ads')||{}).textContent||'—';
  if(roas==='—'){alert('Calcule primeiro antes de salvar.');return;}

  let nome='';
  if(pubMode==='dash'){
    const idx=document.getElementById('pub-produto-sel').value;
    const prods=getCached('realecom_prods','[]');
    nome=idx!==''?prods[parseInt(idx)].nome:'Produto do Dashboard';
  }else{
    nome=document.getElementById('pub-m-nome').value.trim();
    if(!nome){alert('Informe o nome do produto para salvar.');document.getElementById('pub-m-nome').focus();return;}
  }

  const historico=getCached('realecom_pub_historico','[]');
  historico.unshift({id:Date.now(),nome,roas,acos,margem});
  setCached('realecom_pub_historico',historico);
  renderHistoricoPublicidade();
  alert('✅ Análise salva!');
}

function renderHistoricoPublicidade(){
  const historico=getCached('realecom_pub_historico','[]');
  const wrap=document.getElementById('pub-historico-wrap');
  const el=document.getElementById('pub-historico');
  if(!wrap||!el)return;
  if(!historico.length){wrap.style.display='none';return;}
  wrap.style.display='block';
  el.innerHTML=historico.map(h=>`
    <div class="prod-item" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:7px">
      <div style="font-weight:700;color:var(--text);font-size:.82rem">${h.nome}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:.78rem;align-items:center">
        <span>ROAS: <strong style="color:#c4b5fd">${h.roas}</strong></span>
        <span>ACOS: <strong style="color:var(--in)">${h.acos}</strong></span>
        <span>Margem ads: <strong style="color:var(--o)">${h.margem}</strong></span>
        <button onclick="removerAnalisePublicidade(${h.id})" style="background:none;border:none;color:#4a3f6b;cursor:pointer;font-size:.85rem;padding:2px 5px" title="Remover">×</button>
      </div>
    </div>`).join('');
}

function removerAnalisePublicidade(id){
  const historico=getCached('realecom_pub_historico','[]').filter(h=>h.id!==id);
  setCached('realecom_pub_historico',historico);
  renderHistoricoPublicidade();
}

// ============================================================
const SN_ANEXO1 = [
  {faixa:'1ª Faixa', min:0.01,       max:180000,    nominal:0.04,  deducao:0,      irpj:0.055, csll:0.035, cofins:0.1274, pis:0.0276, cpp:0.415,  icms:0.34},
  {faixa:'2ª Faixa', min:180000.01,  max:360000,    nominal:0.073, deducao:5940,   irpj:0.055, csll:0.035, cofins:0.1274, pis:0.0276, cpp:0.415,  icms:0.34},
  {faixa:'3ª Faixa', min:360000.01,  max:720000,    nominal:0.095, deducao:13860,  irpj:0.055, csll:0.035, cofins:0.1274, pis:0.0276, cpp:0.42,   icms:0.335},
  {faixa:'4ª Faixa', min:720000.01,  max:1800000,   nominal:0.107, deducao:22500,  irpj:0.055, csll:0.035, cofins:0.1274, pis:0.0276, cpp:0.42,   icms:0.335},
  {faixa:'5ª Faixa', min:1800000.01, max:3600000,   nominal:0.143, deducao:87300,  irpj:0.055, csll:0.035, cofins:0.1274, pis:0.0276, cpp:0.42,   icms:0.335},
  {faixa:'6ª Faixa', min:3600000.01, max:4800000,   nominal:0.19,  deducao:378000, irpj:0.135, csll:0.1,   cofins:0.2827, pis:0.0613, cpp:0.421,  icms:0},
];

function calcularSimples(){
  const rbt12  = parseMasked(document.getElementById('sn-rbt12'));
  const mensal = parseMasked(document.getElementById('sn-mensal'));
  const res    = document.getElementById('sn-resultado');
  const empty  = document.getElementById('sn-empty');

  if(!rbt12||!mensal){res.style.display='none';empty.style.display='block';empty.innerHTML='<div style="font-size:2.5rem">🧾</div><p style="font-size:.8rem;color:#888;margin-top:8px;line-height:1.6">Preencha o faturamento acima<br>para ver os cálculos</p>';return;}

  const faixaObj=SN_ANEXO1.find(f=>rbt12>=f.min&&rbt12<=f.max);
  if(!faixaObj){
    res.style.display='none';empty.style.display='block';
    empty.innerHTML='<div style="font-size:2.5rem">⚠️</div><p style="font-size:.8rem;color:var(--out);margin-top:8px">Faturamento acima do limite do Simples Nacional (R$ 4,8 milhões/ano)</p>';
    return;
  }

  const aliqEfetiva=(rbt12*faixaObj.nominal-faixaObj.deducao)/rbt12;
  const das=mensal*aliqEfetiva;
  res.style.display='block';empty.style.display='none';

  const fmtPct=v=>(v*100).toFixed(2).replace('.',',')+' %';
  const fmtRange=f=>'R$ '+(f.min).toLocaleString('pt-BR',{maximumFractionDigits:0})+' – R$ '+(f.max).toLocaleString('pt-BR',{maximumFractionDigits:0});

  const hs=document.getElementById('sn-head-stats'); if(hs) hs.style.display='flex';
  const sh=function(id,v){const e=document.getElementById(id); if(e) e.textContent=v;};
  sh('hd-sn-faixa', faixaObj.faixa.replace(' Faixa',''));
  sh('hd-sn-aliq', fmtPct(aliqEfetiva));
  sh('hd-sn-das', fmt(das));
  (function(){const el=document.getElementById('sn-faixa');if(el)el.textContent=faixaObj.faixa;})();
  (function(){const el=document.getElementById('sn-faixa-range');if(el)el.textContent=fmtRange(faixaObj);})();
  (function(){const el=document.getElementById('sn-aliq-efetiva');if(el)el.textContent=fmtPct(aliqEfetiva);})();
  (function(){const el=document.getElementById('sn-das');if(el)el.innerHTML='<span id="sn-das-mk">'+fmt(das)+'</span>';})();
  pintarMarca('sn-das-mk');
  (function(){const el=document.getElementById('sn-d-rbt12');if(el)el.textContent=fmt(rbt12);})();
  (function(){const el=document.getElementById('sn-d-nominal');if(el)el.textContent=fmtPct(faixaObj.nominal);})();
  (function(){const el=document.getElementById('sn-d-deducao');if(el)el.textContent=fmt(faixaObj.deducao);})();
  (function(){const el=document.getElementById('sn-d-efetiva');if(el)el.textContent=fmtPct(aliqEfetiva);})();
  (function(){const el=document.getElementById('sn-d-mensal');if(el)el.textContent=fmt(mensal);})();
  (function(){const el=document.getElementById('sn-d-das');if(el)el.textContent=fmt(das);})();

  const tributos=[
    {nome:'IRPJ',   pct:faixaObj.irpj,   cor:'var(--text2)'},
    {nome:'CSLL',   pct:faixaObj.csll,   cor:'var(--text2)'},
    {nome:'Cofins', pct:faixaObj.cofins, cor:'#f472b6'},
    {nome:'PIS',    pct:faixaObj.pis,    cor:'#fb923c'},
    {nome:'CPP',    pct:faixaObj.cpp,    cor:'var(--in)'},
    {nome:'ICMS',   pct:faixaObj.icms,   cor:'#facc15'},
  ].filter(t=>t.pct>0);

  const elTrib=document.getElementById('sn-tributos');
  if(elTrib) elTrib.innerHTML=tributos.map(t=>`
    <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;border-top:3px solid ${t.cor}">
      <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${t.cor};margin-bottom:4px">${t.nome}</div>
      <div style="font-size:.82rem;font-weight:800;color:var(--text)">${fmt(das*t.pct)}</div>
      <div style="font-size:.65rem;color:var(--text3);margin-top:2px">${fmtPct(t.pct)} do DAS</div>
    </div>`).join('');
}

// ============================================================
// METAS — Nova versão com períodos
// ============================================================

function carregarMetas(){
  const m=getCached('realecom_metas','{}');
  const elDia=document.getElementById('meta-prod-dia');
  const elDias=document.getElementById('meta-dias-semana');
  if(m.prodDia&&elDia)elDia.value=m.prodDia;
  if(m.diasSemana&&elDias)elDias.value=m.diasSemana;
  atualizarQualidade();
  if(m.prodDia&&m.diasSemana)recalcularMetas();
}

function atualizarQualidade(){
  if(!document.getElementById('qual-total'))return;
  const m=getCached('realecom_metas','{}');
  const dataInicio=m.dataInicio?new Date(m.dataInicio):new Date(0);
  const todos=getCached('realecom_prods','[]');

  const agora=Date.now();
  const limite30=agora-(30*24*60*60*1000);
  const prodsMes=todos.filter(p=>{
    const ts=typeof p.id==='number'?p.id:parseInt(p.id);
    return ts>=limite30;
  });

  const qualTotal=document.getElementById('qual-total');
  if(qualTotal)qualTotal.textContent=prodsMes.length;

  const roi160=prodsMes.filter(p=>p.margem&&parseFloat(p.margem)>=10&&parseFloat(p.margem)<15).length;
  const roi180=prodsMes.filter(p=>p.margem&&parseFloat(p.margem)>=15&&parseFloat(p.margem)<20).length;
  const roi200=prodsMes.filter(p=>p.margem&&parseFloat(p.margem)>=20).length;

  const q160=document.getElementById('qual-roi160');
  const q180=document.getElementById('qual-roi180');
  const q200=document.getElementById('qual-roi200');
  if(q160)q160.textContent=roi160;
  if(q180)q180.textContent=roi180;
  if(q200)q200.textContent=roi200;

  const comML=prodsMes.filter(p=>p.precoML&&p.precoML>0);
  const ticketMedio=comML.length>0?(comML.reduce((s,p)=>s+parseFloat(p.precoML),0)/comML.length):0;
  const qTicket=document.getElementById('qual-ticket');
  if(qTicket)qTicket.textContent=ticketMedio>0?'R$ '+ticketMedio.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}):'R$ —';
}

function salvarMetas(){
  const prodDia=parseInt(document.getElementById('meta-prod-dia').value)||0;
  const diasSemana=parseInt(document.getElementById('meta-dias-semana').value)||0;
  if(!prodDia||!diasSemana){
    alert('Preencha os campos: quantos produtos por dia e quantos dias por semana.');
    return;
  }
  const m=getCached('realecom_metas','{}');
  m.prodDia=prodDia;
  m.diasSemana=diasSemana;
  if(!m.dataInicio)m.dataInicio=new Date().toISOString();
  try{
    setCached('realecom_metas',m);
    fbSet('metas', m);
    recalcularMetas();
    alert('✅ Metas salvas com sucesso!');
  }catch(e){
    alert('Erro ao salvar: '+e.message);
  }
}

function atualizarNota(v){
  (function(){const el=document.getElementById('nota-display');if(el)el.textContent=parseFloat(v).toFixed(1).replace('.',',');})();
}

function recalcularMetas(){
  const elDia=document.getElementById('meta-prod-dia');
  const elDias=document.getElementById('meta-dias-semana');
  if(!elDia||!elDias)return;
  const prodDia=parseInt(elDia.value)||0;
  const diasSem=parseInt(elDias.value)||0;
  if(!prodDia||!diasSem)return;

  const metaSemana=prodDia*diasSem;
  const metaQuinzena=metaSemana*2;
  const metaMes=metaSemana*4;

  (function(){const el=document.getElementById('meta-resumo');if(el)el.style.display='block';})();
  (function(){const el=document.getElementById('meta-val-semana');if(el)el.textContent=metaSemana+' produtos';})();
  (function(){const el=document.getElementById('meta-val-quinzena');if(el)el.textContent=metaQuinzena+' produtos';})();
  (function(){const el=document.getElementById('meta-val-mes');if(el)el.textContent=metaMes+' produtos';})();

  const m=getCached('realecom_metas','{}');
  const dataInicio=m.dataInicio?new Date(m.dataInicio):new Date();
  const prods=getCached('realecom_prods','[]');

  function prodsPeriodo(dias){
    const agora=Date.now();
    const limiteMs=agora-(dias*24*60*60*1000);
    const limiteReal=Math.max(dataInicio.getTime(),limiteMs);
    return prods.filter(p=>{
      const ts=typeof p.id==='number'?p.id:parseInt(p.id);
      return ts>=limiteReal;
    });
  }

  const prodsSemana=prodsPeriodo(7);
  const prodsQuinzena=prodsPeriodo(15);
  const prodsMes=prodsPeriodo(30);
  function comprados(lista){return lista.filter(p=>p.comprado).length;}

  function atualizarGrafico(prefix,lista,meta,circumference){
    const qtd=lista.length,comp=comprados(lista);
    const pct=meta>0?Math.min(Math.round((qtd/meta)*100),100):0;
    const offset=circumference-(pct/100)*circumference;
    const circle=document.getElementById('circle-'+prefix);
    if(circle){
      circle.style.strokeDashoffset=offset;
      circle.style.transition='stroke-dashoffset .8s ease';
      if(pct>=100)circle.setAttribute('stroke','var(--in)');
    }
    const pctEl=document.getElementById('pct-'+prefix+'-num');
    if(pctEl)pctEl.textContent=pct+'%';
    const faltam=Math.max(meta-qtd,0);
    const infoEl=document.getElementById('info-'+prefix);
    if(infoEl){
      infoEl.innerHTML=`<strong style="color:var(--text);font-size:.75rem">${qtd}/${meta}</strong> produtos<br>`+
        (comp>0?`<span style="color:var(--in)">⭐ ${comp} comprado${comp>1?'s':''}</span>`:'<span style="color:var(--text3)">nenhum comprado</span>');
    }
    const resumoEl=document.getElementById('resumo-'+prefix);
    if(resumoEl){
      const cor=pct>=100?'var(--in)':pct>=50?'var(--text2)':'var(--text2)';
      resumoEl.innerHTML=`<span style="color:${cor};font-weight:700">${pct>=100?'🎉':'📍'} ${prefix==='semana'?'Esta semana':prefix==='quinzena'?'Quinzena':'Este mês'}:</span> `+
        `${qtd} produto${qtd!==1?'s':''} analisado${qtd!==1?'s':''}${comp>0?` · <strong style="color:var(--in)">${comp} comprado${comp>1?'s':''}</strong>`:''}.  `+
        (faltam>0?`Faltam <strong style="color:var(--o)">${faltam}</strong> para bater a meta.`:`<strong style="color:var(--in)">Meta atingida!</strong>`);
    }
    return {pct,qtd,comp};
  }

  (function(){const el=document.getElementById('resumo-geral');if(el)el.style.display='block';})();
  const s=atualizarGrafico('semana',prodsSemana,metaSemana,314);
  const q=atualizarGrafico('quinzena',prodsQuinzena,metaQuinzena,314);
  const mn=atualizarGrafico('mes',prodsMes,metaMes,314);

  atualizarQualidade();
}

// ============================================================
// FRETE FULL — cálculo por unidade
// ============================================================
function calcFreteFullUnit(){
  const total=parseFloat(document.getElementById('frete-full').value)||0;
  const qtd=parseInt(document.getElementById('frete-full-qtd').value)||0;
  const res=document.getElementById('frete-full-result');
  const uni=document.getElementById('frete-full-unit');
  if(total>0&&qtd>0){
    const porUnit=total/qtd;
    res.style.display='block';
    uni.textContent=fmt(porUnit)+' por unidade';
  }else{
    res.style.display='none';
  }
}

// ============================================================
// DEVOLUÇÃO
// ============================================================
function calcRanqueamento(){
  if(!lastCalc)return;
  const precoRank=parseFloat(document.getElementById('rank-preco').value)||0;
  const qtdRank=parseInt(document.getElementById('rank-qtd').value)||0;
  const res=document.getElementById('rank-resultado');
  if(!precoRank||!qtdRank){res.style.display='none';return;}

  const {pI,pC,pA,custo,frete,ins}=lastCalc;
  const vI=precoRank*pI,vC=precoRank*pC,vA=precoRank*pA;
  const payoutRank=precoRank-custo-frete-ins-vI-vC-vA;
  const fatTotal=precoRank*qtdRank;
  const lucroTotal=payoutRank*qtdRank;
  const impacto=lastCalc.payout>0?(lastCalc.payout-payoutRank)*qtdRank:null;

  res.style.display='block';
  (function(){const el=document.getElementById('rank-fat');if(el)el.textContent=fmt(fatTotal);})();

  const elLucro=document.getElementById('rank-lucro');
  elLucro.textContent=fmt(lucroTotal);
  elLucro.style.color=lucroTotal>=0?'var(--in)':'var(--out)';

  const elImpacto=document.getElementById('rank-impacto');
  if(impacto!==null){
    elImpacto.textContent=fmt(Math.abs(impacto));
    elImpacto.style.color=impacto>0?'var(--out)':'var(--in)';
    (function(){const el=document.getElementById('rank-impacto-label');if(el)el.textContent=impacto>0?'Deixou de ganhar':'Ganho extra vs preço ideal';})();
  }

  const elPayUnit=document.getElementById('rank-pay-unit');
  elPayUnit.textContent=fmt(payoutRank)+'/unid.';
  elPayUnit.style.color=payoutRank>=0?'var(--in)':'var(--out)';
}

function calcDevolucao(){
  const taxa=parseFloat(document.getElementById('dev-taxa').value)||0;
  const msg=document.getElementById('dev-msg');
  const vendasEl=document.getElementById('dev-vendas');
  if(taxa<=0){
    vendasEl.textContent='—';
    msg.textContent='Informe o valor da taxa de devolução para calcular.';
    return;
  }
  const vendasNecessarias=Math.ceil(taxa/lastCalc.payout);
  vendasEl.textContent=vendasNecessarias;
  msg.textContent=`Com lucro de ${fmt(lastCalc.payout)} por unidade, você precisa fazer ${vendasNecessarias} venda${vendasNecessarias>1?'s':''} para cobrir uma devolução de ${fmt(taxa)}.`;
}

// ============================================================
// BUSCADOR DE NCM — busca local aprimorada
// ============================================================
const BASE_NCM = [
  // VESTUÁRIO MASCULINO
  {cod:'6105.10.00', desc:'Camisetas de malha de algodão para homens', palavras:'camiseta camisa polo malha algodao homem masculino basica dry fit academia'},
  {cod:'6105.20.00', desc:'Camisetas de malha de fibras sintéticas para homens', palavras:'camiseta camisa malha sintetica poliester masculino dry fit esporte'},
  {cod:'6109.10.00', desc:'T-shirts e camisetas interiores de algodão', palavras:'tshirt camiseta basica algodao regata interior branca preta'},
  {cod:'6203.42.00', desc:'Calças e bermudas de algodão para homens', palavras:'calca bermuda shorts jeans algodao masculino homem cargo jogger'},
  {cod:'6203.32.00', desc:'Jaquetas e blusões de fibras sintéticas para homens', palavras:'jaqueta blusao corta vento sintetica masculino homem'},
  {cod:'6203.22.00', desc:'Conjuntos de algodão para homens', palavras:'conjunto moletom algodao masculino agasalho'},
  // VESTUÁRIO FEMININO
  {cod:'6106.10.00', desc:'Blusas e camiseiros de malha de algodão para mulheres', palavras:'blusa blusao camiseiro malha algodao feminino mulher'},
  {cod:'6104.62.00', desc:'Calças e bermudas de algodão para mulheres', palavras:'calca bermuda legging algodao feminino mulher'},
  {cod:'6204.62.00', desc:'Calças e jardineiras de algodão para mulheres', palavras:'calca jeans algodao feminino mulher jardeira'},
  {cod:'6104.13.00', desc:'Casacos e jaquetas de malha sintética para mulheres', palavras:'casaco jaqueta malha sintetica feminino mulher'},
  {cod:'6104.43.00', desc:'Vestidos de malha sintética para mulheres', palavras:'vestido malha sintetica feminino mulher'},
  {cod:'6108.21.00', desc:'Camisolas e pijamas de algodão para mulheres', palavras:'pijama camisola algodao feminino mulher dormir'},
  // VESTUÁRIO INFANTIL
  {cod:'6111.20.00', desc:'Vestuário de malha de algodão para bebês', palavras:'roupa bebe malha algodao infantil recem nascido body'},
  {cod:'6209.20.00', desc:'Vestuário de algodão para bebês', palavras:'roupa bebe algodao infantil crianca macacão'},
  {cod:'6110.20.10', desc:'Suéteres e pulôveres de algodão para crianças', palavras:'sueter pulover moletom algodao crianca infantil'},
  // ACESSÓRIOS VESTUÁRIO
  {cod:'6217.10.00', desc:'Acessórios de vestuário de malha', palavras:'gorro touca luva lenco cachecol acessorio malha'},
  {cod:'6214.20.00', desc:'Xales, lenços e cachecóis de lã', palavras:'xale lenco cachecol la frio inverno'},
  {cod:'6215.20.00', desc:'Gravatas e laços de seda ou fibras sintéticas', palavras:'gravata laco borboleta seda sintetica'},
  // CALÇADOS
  {cod:'6404.11.00', desc:'Tênis esportivos com sola de borracha e cabedal têxtil', palavras:'tenis esportivo corrida borracha textil sport academia running'},
  {cod:'6404.19.00', desc:'Calçados casuais com sola de borracha e cabedal têxtil', palavras:'tenis casual sapatenis lona borracha textil'},
  {cod:'6403.91.00', desc:'Calçados de couro com sola de borracha para adultos', palavras:'sapato social couro borracha adulto masculino feminino'},
  {cod:'6402.99.00', desc:'Sandálias e chinelos de borracha ou plástico', palavras:'sandalia chinelo havaianas borracha plastico praia'},
  {cod:'6401.92.00', desc:'Botas impermeáveis com biqueira protetora', palavras:'bota impermeavel biqueira protecao seguranca trabalho'},
  {cod:'6403.51.00', desc:'Calçados de couro com biqueira metálica', palavras:'sapato social couro biqueira metal seguranca'},
  {cod:'6405.20.00', desc:'Calçados com cabedal de matéria têxtil (outros)', palavras:'alpargata espadrille textil simples'},
  // ELETRÔNICOS — ÁUDIO
  {cod:'8518.30.00', desc:'Fones de ouvido (headphone/headset)', palavras:'fone ouvido headphone headset auricular bluetooth sem fio gamer'},
  {cod:'8518.21.00', desc:'Alto-falantes em caixas acústicas', palavras:'caixa som alto falante speaker bluetooth portatil'},
  {cod:'8518.22.00', desc:'Alto-falantes múltiplos em caixas acústicas', palavras:'caixa som home theater subwoofer'},
  {cod:'8518.10.00', desc:'Microfones', palavras:'microfone estudio condensador dinamico usb'},
  // ELETRÔNICOS — TELEFONIA
  {cod:'8517.12.31', desc:'Telefone celular portátil (smartphone)', palavras:'celular smartphone telefone movel iphone android samsung'},
  {cod:'8517.12.13', desc:'Outros aparelhos telefônicos sem fio', palavras:'telefone sem fio fixo residencial'},
  // ELETRÔNICOS — INFORMÁTICA
  {cod:'8471.30.12', desc:'Notebooks e laptops até 3,5kg', palavras:'notebook laptop computador portatil leve ultrafino'},
  {cod:'8471.41.10', desc:'Computadores desktop', palavras:'computador desktop pc mesa torre processador'},
  {cod:'8471.60.52', desc:'Teclados para computadores', palavras:'teclado computador mecanico membrana gamer wireless'},
  {cod:'8471.60.53', desc:'Mouses para computadores', palavras:'mouse raton gamer optico wireless sem fio'},
  {cod:'8528.72.20', desc:'Monitores de vídeo colorido', palavras:'monitor tela display computador gamer 4k'},
  {cod:'8523.51.10', desc:'Cartões de memória flash e pen drives', palavras:'pendrive cartao memoria flash usb sd micro'},
  {cod:'8504.40.40', desc:'Carregadores e fontes de alimentação', palavras:'carregador celular fonte adaptador notebook tomada'},
  {cod:'8507.60.00', desc:'Baterias e acumuladores de íons de lítio', palavras:'bateria litio powerbank carregador portatil'},
  {cod:'8443.32.29', desc:'Impressoras jato de tinta ou laser', palavras:'impressora jato tinta laser multifuncional'},
  // ELETRÔNICOS — CÂMERAS
  {cod:'9006.52.00', desc:'Máquinas fotográficas digitais', palavras:'camera fotografica digital reflex mirrorless'},
  {cod:'8525.80.29', desc:'Câmeras de vídeo e action cameras', palavras:'camera video action cam gopro filmadora'},
  {cod:'8525.80.11', desc:'Webcams e câmeras para computador', palavras:'webcam camera computador streaming videoconferencia'},
  // ELETRÔNICOS — WEARABLES
  {cod:'9102.12.00', desc:'Relógios de pulso eletrônicos (smartwatch)', palavras:'smartwatch relogio inteligente pulso digital smart'},
  {cod:'8543.70.99', desc:'Pulseiras e rastreadores de atividade fitness', palavras:'pulseira fitness rastreador atividade banda smart'},
  // ELETRÔNICOS — TV E VÍDEO
  {cod:'8528.72.10', desc:'Televisores de tela plana', palavras:'televisao tv tela plana lcd led oled smart'},
  {cod:'8521.90.19', desc:'Aparelhos de gravação e reprodução de vídeo', palavras:'dvd blu ray player reprodutor video'},
  // BOLSAS E ACESSÓRIOS
  {cod:'4202.12.00', desc:'Malas e mochilas de plástico ou matéria têxtil', palavras:'mochila mala bolsa viagem nylon poliester tecido'},
  {cod:'4202.22.00', desc:'Bolsas de mão de matéria têxtil', palavras:'bolsa mao carteira clutch feminina textil tecido'},
  {cod:'4202.11.00', desc:'Malas e maletas de couro natural', palavras:'mala maleta couro viagem executiva'},
  {cod:'4202.31.00', desc:'Carteiras e porta-documentos de couro', palavras:'carteira porta documentos couro masculino feminino'},
  {cod:'4205.00.00', desc:'Cintos e correias de couro', palavras:'cinto couro masculino feminino'},
  // CASA E DECORAÇÃO
  {cod:'3924.10.00', desc:'Louças e artigos domésticos de plástico', palavras:'pote vasilha caixa organizador plastico cozinha domestico'},
  {cod:'3924.90.00', desc:'Outros artigos domésticos de plástico', palavras:'balde bacia plastico domestico'},
  {cod:'6302.60.00', desc:'Toalhas de banho e mesa de algodão', palavras:'toalha banho mesa algodao'},
  {cod:'9404.90.00', desc:'Almofadas travesseiros e artigos de cama', palavras:'almofada travesseiro edredom colcha cama'},
  {cod:'6303.92.00', desc:'Cortinas e persianas de fibras sintéticas', palavras:'cortina persiana blackout sintetica'},
  {cod:'7323.93.00', desc:'Artefatos de aço inoxidável para uso doméstico', palavras:'panela frigideira aco inox cozinha'},
  {cod:'7323.94.00', desc:'Artefatos de ferro ou aço para uso doméstico', palavras:'forma assadeira ferro aco cozinha forno'},
  {cod:'8516.60.00', desc:'Fornos elétricos e micro-ondas', palavras:'forno eletrico micro ondas cozinha'},
  {cod:'8516.40.00', desc:'Ferros elétricos de passar roupa', palavras:'ferro passar roupa eletrico vapor'},
  {cod:'8509.40.00', desc:'Batedeiras e misturadores de alimentos', palavras:'batedeira liquidificador mixer processador alimento cozinha'},
  {cod:'8509.80.00', desc:'Aspiradores de pó', palavras:'aspirador po eletrico domestico'},
  // MÓVEIS
  {cod:'9403.20.00', desc:'Móveis de metal para uso doméstico', palavras:'rack suporte prateleira metal movel estante'},
  {cod:'9403.30.00', desc:'Móveis de madeira para escritório', palavras:'mesa cadeira escritorio madeira'},
  {cod:'9403.60.00', desc:'Móveis de madeira para uso doméstico', palavras:'armario guarda roupa estante madeira quarto'},
  {cod:'9401.61.00', desc:'Assentos com armação de madeira estofados', palavras:'sofa poltrona cadeira madeira estofada'},
  // BANHEIRO — ESPELHOS E ARMÁRIOS
  {cod:'7009.92.00', desc:'Espelhos de vidro com moldura', palavras:'espelho moldura banheiro quarto parede vidro'},
  {cod:'3922.10.00', desc:'Banheiras e artigos sanitários de plástico', palavras:'armario banheiro plastico pvc sanitario'},
  {cod:'7615.10.00', desc:'Artigos de uso doméstico de alumínio', palavras:'armario banheiro aluminio espelho'},
  // BELEZA E CUIDADOS
  {cod:'3304.10.00', desc:'Produtos de maquiagem para lábios', palavras:'batom lip gloss labial brilho maquiagem'},
  {cod:'3304.20.00', desc:'Preparações para maquiagem dos olhos', palavras:'mascara rimel sombra delineador base olhos maquiagem'},
  {cod:'3304.99.90', desc:'Outras preparações de beleza e maquiagem', palavras:'base po facial blush contorno maquiagem'},
  {cod:'3305.10.00', desc:'Xampus para cabelo', palavras:'xampu shampoo cabelo higiene limpeza'},
  {cod:'3305.30.00', desc:'Laquês para cabelo', palavras:'laque spray fixador cabelo'},
  {cod:'3307.20.00', desc:'Desodorantes corporais e antitranspirantes', palavras:'desodorante antitranspirante roll on aerosol corpo'},
  {cod:'3401.11.90', desc:'Sabões de toucador em barras', palavras:'sabao sabonete barra higiene banho'},
  {cod:'3307.10.00', desc:'Preparações para barbear', palavras:'creme gel espuma barbear barba'},
  {cod:'3304.30.00', desc:'Preparações para manicure e pedicure', palavras:'esmalte unha removedor acetona manicure'},
  // ESPORTE E FITNESS
  {cod:'9506.62.00', desc:'Bolas de futebol, basquete e outros esportes', palavras:'bola futebol basquete volei tenis esporte'},
  {cod:'9506.91.00', desc:'Artigos e equipamentos para ginástica', palavras:'halter haltere peso musculacao fitness caneleira'},
  {cod:'9506.11.00', desc:'Esquis e artigos de esqui aquático', palavras:'esqui prancha surf wakeboard'},
  {cod:'9506.99.00', desc:'Outros artigos para esportes e lazer', palavras:'corda pular elástico exercicio treino'},
  {cod:'9507.10.00', desc:'Varas de pesca', palavras:'vara pesca molinete carretilha pesca'},
  // BRINQUEDOS
  {cod:'9503.00.31', desc:'Brinquedos com motor elétrico', palavras:'brinquedo eletrico motor controle remoto carro drone'},
  {cod:'9503.00.10', desc:'Bonecas e bonecos', palavras:'boneca boneco bebe barbie action figure'},
  {cod:'9503.00.99', desc:'Outros brinquedos', palavras:'brinquedo plastico crianca educativo'},
  {cod:'9504.50.00', desc:'Consoles e máquinas de videogame', palavras:'videogame console playstation xbox nintendo joystick controle'},
  {cod:'9504.90.00', desc:'Jogos de tabuleiro, cartas e similares', palavras:'jogo tabuleiro carta baralho xadrez'},
  // PETS
  {cod:'4201.00.00', desc:'Arreios e artigos para animais', palavras:'coleira guia peitoral cachorro gato pet'},
  {cod:'9508.90.00', desc:'Artigos e acessórios para animais de estimação', palavras:'cama casinha brinquedo pet comedouro bebedouro'},
  {cod:'2309.10.00', desc:'Alimentos para cães e gatos', palavras:'racao cachorro gato pet alimento'},
  // FERRAMENTAS
  {cod:'8467.19.00', desc:'Ferramentas elétricas de uso manual', palavras:'furadeira parafusadeira lixadeira esmerilhadeira eletrica'},
  {cod:'8205.20.00', desc:'Martelos e marretas', palavras:'martelo marreta ferramenta manual'},
  {cod:'8211.93.00', desc:'Facas de mesa e de cozinha', palavras:'faca cozinha cutelaria chef corte'},
  // PAPELARIA E ESCRITÓRIO
  {cod:'4820.10.20', desc:'Cadernos escolares e universitários', palavras:'caderno escolar universitario espiral'},
  {cod:'9608.10.00', desc:'Canetas esferográficas', palavras:'caneta esferografica bic escrita'},
  {cod:'9612.10.00', desc:'Fitas para impressoras e máquinas de escrever', palavras:'toner cartucho tinta impressora'},
  // SUPLEMENTOS E SAÚDE
  {cod:'2106.90.90', desc:'Preparações alimentícias diversas (suplementos)', palavras:'suplemento proteina whey creatina bcaa pre treino'},
  {cod:'3004.50.99', desc:'Medicamentos e vitaminas embalados para venda a retalho', palavras:'vitamina suplemento capsulas comprimido'},
  // AUTOMÓVEIS E ACESSÓRIOS
  {cod:'8708.99.90', desc:'Partes e acessórios para veículos automóveis', palavras:'acessorio carro auto veiculo'},
  {cod:'8512.20.00', desc:'Aparelhos de iluminação para veículos', palavras:'farol lanterna luz led carro moto'},
  {cod:'4011.10.00', desc:'Pneus novos para automóveis', palavras:'pneu carro automovel borracha'},
];

// Normaliza texto removendo acentos
function normalizarTexto(t){
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s]/g,'');
}

// Score de relevância entre query e NCM
function calcularScore(query, ncm){
  const tokens = normalizarTexto(query).split(/\s+/).filter(t=>t.length>2);
  const haystack = normalizarTexto(ncm.desc + ' ' + ncm.palavras);
  let score = 0;
  tokens.forEach(t=>{
    const re = new RegExp('\\b'+t, 'g');
    const matches = (haystack.match(re)||[]).length;
    if(matches>0) score += t.length * matches * 2;
    else if(haystack.includes(t)) score += t.length;
  });
  tokens.forEach(t=>{
    if(normalizarTexto(ncm.desc).includes(t)) score += 5;
  });
  return score;
}

let ncmSelecionado = null;

function buscarNCM(){
  const query = document.getElementById('ncm-input').value.trim();
  if(!query){alert('Digite o nome do produto.');return;}
  _executarBuscaNCM(query);
}

function ncmAtalho(termo){
  document.getElementById('ncm-input').value = termo;
  _executarBuscaNCM(termo);
}

function _executarBuscaNCM(query){
  const box = document.getElementById('ncm-resultados-box');
  const lista = document.getElementById('ncm-lista');
  const empty = document.getElementById('ncm-empty');
  const titulo = document.getElementById('ncm-resultado-titulo');

  empty.style.display='none';

  const resultados = BASE_NCM
    .map(n=>({...n, score:calcularScore(query,n)}))
    .filter(n=>n.score>0)
    .sort((a,b)=>b.score-a.score)
    .slice(0,5);

  if(!resultados.length){
    box.style.display='none';
    empty.style.display='block';
    empty.style.opacity='1';
    empty.querySelector('p').textContent='Nenhum NCM encontrado. Tente descrever o material e o uso do produto.';
    return;
  }

  box.style.display='block';
  titulo.textContent=`${resultados.length} resultado${resultados.length>1?'s':''} encontrado${resultados.length>1?'s':''}`;

  lista.innerHTML=resultados.map((n,i)=>`
    <div onclick="selecionarNCM('${n.cod}','${n.desc.replace(/'/g,"\'")}',${n.score})" style="border:${i===0?'1.5px solid #0f766e88':'1px solid var(--border)'};background:${i===0?'#0f766e12':'var(--bg2)'};border-radius:9px;padding:10px 12px;cursor:pointer;transition:all .2s;margin-bottom:${i<resultados.length-1?'7px':'0'}">
      <div style="font-size:.82rem;font-weight:800;font-family:monospace;color:${i===0?'#0d9488':'var(--text)'};margin-bottom:3px">${n.cod}</div>
      <div style="font-size:.72rem;color:var(--text2);line-height:1.4">${n.desc}</div>
    </div>`).join('');

  selecionarNCM(resultados[0].cod, resultados[0].desc, resultados[0].score, false);
}

function selecionarNCM(cod, desc, score, salvarHist=true){
  ncmSelecionado = {cod, desc};
  (function(){const el=document.getElementById('ncm-detalhe');if(el)el.style.display='block';})();
  (function(){const el=document.getElementById('ncm-detalhe-empty');if(el)el.style.display='none';})();
  (function(){const el=document.getElementById('ncm-codigo-display');if(el)el.textContent=cod;})();
  (function(){const el=document.getElementById('ncm-desc-display');if(el)el.textContent=desc;})();

  if(salvarHist){
    const query=document.getElementById('ncm-input').value.trim();
    const hist=getCached('realecom_ncm_hist','[]');
    const jaExiste=hist.findIndex(h=>h.cod===cod);
    if(jaExiste>=0) hist.splice(jaExiste,1);
    hist.unshift({cod,desc,query});
    setCached('realecom_ncm_hist',hist.slice(0,10));
    renderHistoricoNCM();
  }
}

function copiarNCM(){
  if(!ncmSelecionado) return;
  navigator.clipboard.writeText(ncmSelecionado.cod).then(()=>{
    mostrarNotifMsg({tipo:'outro',data:''},'Código NCM copiado: '+ncmSelecionado.cod,1);
  }).catch(()=>{
    prompt('Copie o código NCM:',ncmSelecionado.cod);
  });
}

function renderHistoricoNCM(){
  const hist=getCached('realecom_ncm_hist','[]');
  const box=document.getElementById('ncm-historico-box');
  const lista=document.getElementById('ncm-historico-lista');
  if(!box||!lista) return;
  if(!hist.length){box.style.display='none';return;}
  box.style.display='block';
  lista.innerHTML=hist.map((h,i)=>`
    <div onclick="ncmAtalho('${h.query}')" style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;${i<hist.length-1?'border-bottom:1px solid var(--border)':''};cursor:pointer">
      <span style="font-size:.76rem;color:var(--text2)">${h.query||h.desc.substring(0,30)}</span>
      <span style="font-size:.7rem;font-family:monospace;color:var(--text3)">${h.cod}</span>
    </div>`).join('');
}

function limparHistoricoNCM(){
  localStorage.removeItem('realecom_ncm_hist');
  renderHistoricoNCM();
}

// ============================================================
// WHATSAPP — cadastro de telefone
// ============================================================

// Salva telefone no Firestore e localStorage
async function salvarTelefone(){
  const input = document.getElementById('wpp-telefone');
  if(!input) return;
  const tel = input.value.replace(/\D/g,'');
  if(tel.length < 10 || tel.length > 11){
    alert('Informe um número válido com DDD (ex: 21999998888)');
    return;
  }
  try{
    const uid = await getUserId();
    if(!uid){ alert('Você precisa estar logado.'); return; }
    const db = await getDB();
    await db.collection('usuarios').doc(uid).set({ telefone: tel }, { merge: true });
    setCached('realecom_telefone', tel);
    atualizarBannerWhatsApp(tel);
    mostrarNotifMsg({tipo:'outro',data:''},'✅ Número salvo! Você receberá lembretes no WhatsApp.',1);
  }catch(e){
    alert('Erro ao salvar: ' + e.message);
  }
}

// Remove telefone
async function removerTelefone(){
  if(!confirm('Deseja parar de receber notificações no WhatsApp?')) return;
  try{
    const uid = await getUserId();
    if(!uid) return;
    const db = await getDB();
    await db.collection('usuarios').doc(uid).update({ telefone: firebase.firestore.FieldValue.delete() });
    (function(){const k=localKey('realecom_telefone');if(k)localStorage.removeItem(k);})();
    atualizarBannerWhatsApp(null);
    mostrarNotifMsg({tipo:'outro',data:''},'Notificações WhatsApp desativadas.',1);
  }catch(e){
    alert('Erro: ' + e.message);
  }
}

// Atualiza o banner no calendário conforme estado
function atualizarBannerWhatsApp(tel){
  calChips();
  const banner = document.getElementById('wpp-banner');
  if(!banner) return;
  if(tel){
    const formatado = tel.replace(/(\d{2})(\d{2})(\d{4,5})(\d{4})/, '+$1 ($2) $3-$4');
    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="width:36px;height:36px;background:#16a34a;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        </div>
        <div style="flex:1">
          <div style="font-size:.82rem;font-weight:700;color:var(--in)">✅ WhatsApp ativo</div>
          <div style="font-size:.7rem;color:var(--text3)">${formatado} · lembretes automáticos ativados</div>
        </div>
        <button onclick="removerTelefone()" style="background:#7f1d1d22;border:1px solid #ef444444;color:var(--out);border-radius:7px;padding:5px 10px;font-size:.72rem;font-weight:600;cursor:pointer">Remover</button>
      </div>`;
  } else {
    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="width:36px;height:36px;background:#16a34a22;border:1px solid #16a34a44;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--in)"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        </div>
        <div style="flex:1">
          <div style="font-size:.82rem;font-weight:700;color:var(--text)">Receba lembretes no WhatsApp</div>
          <div style="font-size:.7rem;color:var(--text3)">Cadastre seu número e receba os mesmos avisos do calendário direto no zap</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="tel" id="wpp-telefone" placeholder="DDD + número" maxlength="11"
            style="padding:7px 10px;border:1.5px solid #16a34a44;border-radius:8px;background:var(--bg2);color:var(--text);font-size:.82rem;outline:none;width:150px;font-family:inherit"
            onkeydown="if(event.key==='Enter')salvarTelefone()">
          <button onclick="salvarTelefone()" style="background:#16a34a;border:none;color:#fff;border-radius:8px;padding:7px 14px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap">Ativar</button>
        </div>
      </div>`;
  }
}

// Carrega telefone ao entrar no calendário
async function carregarTelefoneWhatsApp(){
  const banner = document.getElementById('wpp-banner');
  if(!banner) return;
  // Tenta do cache primeiro
  const cache = getCached('realecom_telefone','null');
  if(cache){ atualizarBannerWhatsApp(cache); return; }
  // Busca no Firestore
  try{
    const uid = await getUserId();
    if(!uid){ atualizarBannerWhatsApp(null); return; }
    const db = await getDB();
    const doc = await db.collection('usuarios').doc(uid).get();
    if(doc.exists && doc.data().telefone){
      setCached('realecom_telefone', doc.data().telefone);
      atualizarBannerWhatsApp(doc.data().telefone);
    } else {
      atualizarBannerWhatsApp(null);
    }
  }catch(e){
    atualizarBannerWhatsApp(null);
  }
}

// ============================================================
// PROMPT FOTOS ML
// ============================================================

function gerarPromptsFotos(){
  const produto = (document.getElementById('pf-produto').value||'').trim();
  const caract  = (document.getElementById('pf-caract').value||'').trim();

  const prod = produto || '[nome do produto]';
  const car  = caract  || '[características obrigatórias]';

  const prompts = {
    '01': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Diretrizes criativas:
• Não vender o produto — vender o motivo da compra.
• A imagem deve parecer uma campanha publicitária de uma grande marca.
• Pergunta-guia: "Qual cena faria alguém clicar neste anúncio em menos de 2 segundos?"

Regras técnicas:
• Produto fiel à referência.
• Produto ocupando entre 60% e 80% da imagem.
• Fundo ambientado.
• Ultra realista — qualidade fotográfica premium.
• Sem aparência de IA.
• Sem selos, preços, ícones ou informações técnicas.
• Criar composição emocional e diferenciada dos concorrentes.
• Formato: 1200 x 1200 px.`,

    '02': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Diretrizes criativas:
• Mostrar cada item incluso individualmente.
• Organização premium — estilo catálogo de marca.
• Visual limpo e fácil leitura no celular.
• A imagem deve transmitir que o cliente recebe um conjunto completo.

Regras técnicas:
• Fundo ambientado elegante.
• Produto fiel.
• Sem aparência de IA.
• Cada item claramente identificado.
• Alta nitidez.
• Visual profissional.
• Formato: 1200 x 1540 px.`,

    '03': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Diretrizes criativas:
• Mostrar uso real com pessoas utilizando o produto naturalmente.
• Vender o resultado — não vender o produto.
• Pergunta-guia: "Como a vida do cliente fica melhor depois da compra?"

Regras técnicas:
• Produto fiel.
• Ambiente coerente com o uso.
• Emoção visível.
• Realismo extremo — qualidade publicitária.
• Sem aparência de IA.
• Formato: 1200 x 1540 px.`,

    '04': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Diretrizes criativas:
• Transformar características em benefícios visuais.
• Não mostrar apenas o produto — mostrar visualmente o benefício.
• Exemplo: em vez de "Material Oxford", mostrar "Maior resistência para a rotina diária".

Regras técnicas:
• Visual premium.
• Fácil leitura no celular.
• Pouco texto — benefícios claros e diretos.
• Produto fiel.
• Formato: 1200 x 1540 px.`,

    '05': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Mostrar obrigatoriamente:
• Acabamentos.
• Materiais.
• Estruturas e detalhes construtivos.

Diretrizes criativas:
• Estilo propaganda de produto premium.
• Iluminação dramática nos detalhes.
• Close nos detalhes construtivos.

Regras técnicas:
• Produto fiel.
• Sem marcas inventadas.
• Sem aparência de IA.
• Alta nitidez.
• Formato: 1200 x 1540 px.`,

    '06': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Mostrar obrigatoriamente:
• Medidas reais.
• Compartimentos.
• Capacidade e peso.
• Especificações relevantes.

Diretrizes criativas:
• Visual moderno — infográfico premium.
• Informações organizadas e hierarquizadas.
• Fácil leitura no celular.

Regras técnicas:
• Produto fiel.
• Visual profissional.
• Formato: 1200 x 1540 px.`,

    '07': `Produto:
• ${prod}

Características que não podem ser alteradas:
• ${car}

Reforçar obrigatoriamente:
• Qualidade.
• Garantia.
• Conjunto completo.
• Benefícios principais.

Diretrizes criativas:
• Pergunta-guia: "Por que comprar este produto agora?"
• Visual elegante com poucos elementos.
• Sensação de decisão de compra — não de ansiedade.

Regras técnicas:
• Produto fiel.
• Fundo ambientado.
• Aparência premium.
• Sem aparência de IA.
• Formato: 1200 x 1540 px.`
  };

  Object.entries(prompts).forEach(([num, txt]) => {
    const el = document.getElementById('pf-txt-' + num);
    if(el) el.textContent = txt;
  });
}

function copiarPrompt(id){
  const el = document.getElementById(id);
  if(!el) return;
  navigator.clipboard.writeText(el.textContent).then(()=>{
    // Feedback visual no botão
    const btn = el.previousElementSibling
      ? null
      : null;
    // Encontra o botão pelo DOM
    const card = el.closest('.card');
    if(!card) return;
    const b = card.querySelector('button');
    if(!b) return;
    const orig = b.innerHTML;
    b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!';
    b.style.color = 'var(--in)';
    b.style.borderColor = '#16a34a44';
    setTimeout(()=>{ b.innerHTML = orig; b.style.color = ''; b.style.borderColor = ''; }, 1800);
  });
}

// Gera os prompts ao entrar na página (com placeholder)

/* ============================================================================
 * MOTOR DE CONCILIAÇÃO MERCADO LIVRE + MERCADO PAGO — Calculadora Realecom
 * v2 — três camadas
 * ----------------------------------------------------------------------------
 *  Camada 1  VENDA  → LIBERAÇÃO   "o ML liberou o que prometeu?"
 *  Camada 2  TARIFAS nominais     "qual tarifa apareceu que não estava na venda?"
 *  Camada 3  LIBERAÇÃO → MERCADO PAGO → SAQUE   "o dinheiro entrou e saiu certo?"
 *
 * Puro: sem DOM, sem framework.
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConciliacaoML = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOLERANCIA = 0.10;

  var VENDA_TIPO = 'Venda', VENDA_STATUS = 'Pago';
  var LIB_TIPOS_OPERACAO = ['Liberação', 'Estorno de liberação', 'Estorno de envio'];
  var LIB_TIPO_ENVIO = 'Liberação de envio';

  /* ---------------------------------------------------------------- helpers */

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v).trim().replace(/[R$\s ]/g, '');
    if (!s || s === '-' || s.toLowerCase() === 'nan') return 0;
    var hasDot = s.indexOf('.') >= 0, hasCom = s.indexOf(',') >= 0;
    if (hasDot && hasCom) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (hasCom) {
      s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }
  function txt(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    return (s === 'nan' || s === 'NaT' || s === 'undefined') ? '' : s;
  }
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /* ------------------------------------------------------- parser de tarifas
   * A coluna "Detalhes de tarifas" traz blocos assim:
   *   {Tarifa 2
   *    ID da tarifa: 67578146752;
   *    Nome da tarifa: Tarifa de envio extra ou intermunicipal;
   *    Valor bruto: R$24,42;
   *    Desconto aplicado: R$7,33;
   *    Valor líquido: R$17,09;
   *    Pós-paga: 0;}
   * É AQUI que mora a explicação de quase toda divergência aparente:
   * comparando a lista da VENDA com a da LIBERAÇÃO você descobre o NOME
   * da tarifa que apareceu depois — deixa de ser "recebi a menos" sem motivo.
   * -------------------------------------------------------------------------*/

  var RX_NOME = /Nome da tarifa:\s*([^;]+);/;
  var RX_LIQ = /Valor líquido:\s*R\$\s*([\d.,-]+)\s*;/;
  var RX_BRUTO = /Valor bruto:\s*R\$\s*([\d.,-]+)\s*;/;
  var RX_DESC = /Desconto aplicado:\s*R\$\s*([\d.,-]+)\s*;/;

  function moeda(s) {
    // no relatório o formato é sempre pt-BR: 1.234,56
    return num(String(s).replace(/\./g, '').replace(',', '.'));
  }

  function parseTarifas(detalhe) {
    var out = {};
    if (typeof detalhe !== 'string' || !detalhe) return out;
    detalhe.split('{').forEach(function (bloco) {
      var n = RX_NOME.exec(bloco), l = RX_LIQ.exec(bloco);
      if (!n || !l) return;
      var nome = n[1].trim();
      var b = RX_BRUTO.exec(bloco), d = RX_DESC.exec(bloco);
      if (!out[nome]) out[nome] = { nome: nome, liquido: 0, bruto: 0, desconto: 0 };
      out[nome].liquido += moeda(l[1]);
      if (b) out[nome].bruto += moeda(b[1]);
      if (d) out[nome].desconto += moeda(d[1]);
    });
    return out;
  }

  function somarTarifas(destino, origem) {
    Object.keys(origem).forEach(function (k) {
      if (!destino[k]) destino[k] = { nome: k, liquido: 0, bruto: 0, desconto: 0 };
      destino[k].liquido += origem[k].liquido;
      destino[k].bruto += origem[k].bruto;
      destino[k].desconto += origem[k].desconto;
    });
    return destino;
  }

  /* ---------------------------------------------------------------- colunas */

  var COL = {
    op: 'Número da operação', envio: 'Número do envio', pacote: 'Número do pacote',
    tipo: 'Tipo de operação', status: 'Status da operação',
    dataOp: 'Data da operação', dataLib: 'Data da liberação',
    item: 'Item', sku: 'SKU', categoria: 'Categoria', anuncio: 'Tipo de anúncio',
    qtd: 'Quantidade de itens', valorItem: 'Valor do item',
    fretePagoComprador: 'Envio pago pelo comprador (+)',
    parcelamentoComprador: 'Taxa de parcelamento paga pelo comprador (+)',
    bruto: 'Valor bruto (=)',
    tarifas: 'Valor total de tarifas (desconto já aplicado)',
    tarifasPos: 'Valor total de tarifas pós-pagas',
    liquido: 'Valor líquido após tarifas',
    fretePagoVendedor: 'Envio pago pelo vendedor',
    reclamacoes: 'Reclamações e devoluções',
    metodoEnvio: 'Método de envio', detalheTarifas: 'Detalhes de tarifas'
  };

  // Colunas do Mercado Pago (header na linha 0, ao contrário do ML)
  var MP = {
    op: 'Número da venda no Mercado Livre (order_id)',
    dataCompra: 'Data da compra (date_created)',
    dataLiberado: 'Data de liberação do dinheiro (date_released)',
    status: 'Status da operação (status)',
    statusDet: 'Detalhe do status da operação (status_detail)',
    valorProduto: 'Valor do produto (transaction_amount)',
    taxaMP: 'Tarifa do Mercado Pago (mercadopago_fee)',
    taxaMarketplace: 'Tarifa pelo uso da plataforma de terceiros (marketplace_fee)',
    frete: 'Frete (shipping_cost)',
    financiamento: 'Custos de parcelamento (financing_fee)',
    cupom: 'Desconto para a sua contraparte (coupon_fee)',
    liquido: 'Valor total recebido (net_received_amount)',
    devolvido: 'Valor devolvido (amount_refunded)',
    claim: 'Número da reclamação (claim_id)',
    chargeback: 'Número da contestação (chargeback_id)',
    // saques
    wData: 'Data de criação da retirada (date_created)',
    wId: 'Número da retirada (withdraw_id)',
    wStatus: 'Status (status)',
    wValor: 'Valor (amount)',
    wTaxa: 'Taxa (fee)',
    wBanco: 'Nome do banco (bank_name)',
    // reclamações / devoluções
    aFluxo: 'Fluxo (flow)',
    aData: 'Data de criação (date_created)',
    aStatus: 'Status (status)',
    aMotivo: 'Motivo detalhado (reason_detail)',
    aValor: 'Valor (amount)',
    aRetido: 'Dinheiro da decisão retido (resolution_money_blocked)',
    aOp: 'ID do pedido (order_id)'
  };

  var CAMPOS_SOMA = [COL.qtd, COL.valorItem, COL.fretePagoComprador, COL.parcelamentoComprador,
    COL.bruto, COL.tarifas, COL.tarifasPos, COL.liquido, COL.fretePagoVendedor, COL.reclamacoes];
  var CAMPOS_PRIMEIRO = [COL.dataOp, COL.dataLib, COL.item, COL.sku, COL.categoria,
    COL.anuncio, COL.envio, COL.pacote, COL.metodoEnvio, COL.status];

  function agrupar(linhas, chaveCol) {
    var mapa = new Map();
    linhas.forEach(function (l) {
      var k = txt(l[chaveCol]);
      if (!k) return;
      var acc = mapa.get(k);
      if (!acc) { acc = { _chave: k, _linhas: 0, _tarifas: {} }; mapa.set(k, acc); }
      acc._linhas++;
      CAMPOS_SOMA.forEach(function (c) { acc[c] = (acc[c] || 0) + num(l[c]); });
      CAMPOS_PRIMEIRO.forEach(function (c) { if (!acc[c]) acc[c] = txt(l[c]); });
      somarTarifas(acc._tarifas, parseTarifas(l[COL.detalheTarifas]));
    });
    return mapa;
  }

  /* ---------------------------------------------------------- classificação */

  var ST = {
    OK: 'OK',
    PENDENTE: 'Aguardando liberação',
    COMPETENCIA: 'Competência anterior',
    TARIFA: 'Tarifa não prevista',
    DEVOLUCAO: 'Devolução / reclamação',
    MENOS: 'Recebeu a menos sem explicação',
    MAIS: 'Recebeu a mais'
  };

  // Ordem importa: só sobra em MENOS o que nenhuma explicação cobriu.
  // É esse status — e só ele — que vira reclamação com o ML.
  function classificar(l) {
    if (!l.temLiberacao) return ST.PENDENTE;
    if (Math.abs(l.diferenca) <= TOLERANCIA) return ST.OK;
    if (l.liquidoEsperado < 0 && l.liquidoRecebido > 0) return ST.COMPETENCIA;
    if (l.reclamacoes > TOLERANCIA) return ST.DEVOLUCAO;
    // a falta bate (dentro da tolerância) com tarifas que só apareceram na liberação?
    if (l.diferenca < -TOLERANCIA && l.tarifasSurpresa.length &&
        Math.abs(l.diferenca + l.valorTarifasSurpresa) <= TOLERANCIA) return ST.TARIFA;
    if (l.diferenca < -TOLERANCIA) return ST.MENOS;
    if (l.diferenca > TOLERANCIA) return ST.MAIS;
    return ST.OK;
  }

  /* =================================================== CAMADA 1 + 2 (ML) === */

  function conciliar(vendasRaw, liberacoesRaw, mp) {
    var avisos = [];

    var vendas = vendasRaw.filter(function (l) {
      return txt(l[COL.tipo]) === VENDA_TIPO && txt(l[COL.status]) === VENDA_STATUS;
    });
    var mapaVendas = agrupar(vendas, COL.op);

    var mapaLib = agrupar(liberacoesRaw.filter(function (l) {
      return LIB_TIPOS_OPERACAO.indexOf(txt(l[COL.tipo])) >= 0;
    }), COL.op);

    // Liberação de envio: SEM Número da operação. Só liga pelo Número do envio.
    var mapaEnvio = new Map();
    liberacoesRaw.forEach(function (l) {
      if (txt(l[COL.tipo]) !== LIB_TIPO_ENVIO) return;
      var k = txt(l[COL.envio]);
      if (!k) return;
      mapaEnvio.set(k, (mapaEnvio.get(k) || 0) + num(l[COL.liquido]));
    });

    // Quantas operações dividem o mesmo envio (pack / carrinho).
    // Numa venda em pack, o ML cobra o frete extra em UMA das operações —
    // sem isso a outra parece ter recebido a menos.
    var opsPorEnvio = new Map();
    mapaVendas.forEach(function (v) {
      var e = txt(v[COL.envio]); if (!e) return;
      opsPorEnvio.set(e, (opsPorEnvio.get(e) || 0) + 1);
    });

    var linhas = [];
    mapaVendas.forEach(function (v, op) {
      var lib = mapaLib.get(op) || null;
      var envioKey = txt(v[COL.envio]);
      var libEnv = envioKey ? (mapaEnvio.get(envioKey) || 0) : 0;

      var tarV = v._tarifas, tarL = lib ? lib._tarifas : {};

      // CAMADA 2 — diff nominal das tarifas
      var surpresa = [], sumiu = [], mudou = [], vSurpresa = 0;
      Object.keys(tarL).forEach(function (k) {
        if (!tarV[k]) { surpresa.push({ nome: k, valor: r2(tarL[k].liquido), bruto: r2(tarL[k].bruto), desconto: r2(tarL[k].desconto) }); vSurpresa += tarL[k].liquido; }
        else if (Math.abs(tarL[k].liquido - tarV[k].liquido) > TOLERANCIA) {
          mudou.push({ nome: k, previsto: r2(tarV[k].liquido), cobrado: r2(tarL[k].liquido), delta: r2(tarL[k].liquido - tarV[k].liquido) });
          vSurpresa += (tarL[k].liquido - tarV[k].liquido);
        }
      });
      Object.keys(tarV).forEach(function (k) {
        if (!tarL[k] && lib) sumiu.push({ nome: k, valor: r2(tarV[k].liquido) });
      });

      var liquidoEsperado = r2(num(v[COL.liquido]));
      var liquidoLib = lib ? r2(num(lib[COL.liquido])) : 0;
      var liquidoRecebido = r2(liquidoLib + libEnv);

      var l = {
        operacao: op, envio: envioKey, pacote: txt(v[COL.pacote]),
        dataVenda: v[COL.dataOp] || '', dataLiberacao: lib ? (lib[COL.dataLib] || '') : '',
        item: v[COL.item] || '', sku: v[COL.sku] || '', categoria: v[COL.categoria] || '',
        tipoAnuncio: v[COL.anuncio] || '', metodoEnvio: v[COL.metodoEnvio] || '',
        quantidade: num(v[COL.qtd]),
        opsNoMesmoEnvio: envioKey ? (opsPorEnvio.get(envioKey) || 1) : 1,

        // previsto (venda)
        valorItem: r2(num(v[COL.valorItem])),
        fretePagoComprador: r2(num(v[COL.fretePagoComprador])),
        brutoEsperado: r2(num(v[COL.bruto])),
        comissaoEsperada: r2(num(v[COL.tarifas]) + num(v[COL.tarifasPos])),
        freteEsperado: r2(num(v[COL.fretePagoVendedor])),
        liquidoEsperado: liquidoEsperado,
        tarifasVenda: Object.keys(tarV).map(function (k) { return { nome: k, valor: r2(tarV[k].liquido) }; }),

        // realizado (liberação)
        brutoLiberado: lib ? r2(num(lib[COL.bruto])) : 0,
        comissaoCobrada: lib ? r2(num(lib[COL.tarifas]) + num(lib[COL.tarifasPos])) : 0,
        freteCobrado: lib ? r2(num(lib[COL.fretePagoVendedor])) : 0,
        reclamacoes: lib ? r2(num(lib[COL.reclamacoes])) : 0,
        liquidoLiberacao: liquidoLib, liquidoEnvio: r2(libEnv),
        liquidoRecebido: liquidoRecebido,
        temLiberacao: !!lib, eventosLiberacao: lib ? lib._linhas : 0,
        tarifasLiberacao: Object.keys(tarL).map(function (k) { return { nome: k, valor: r2(tarL[k].liquido) }; }),

        // camada 2
        tarifasSurpresa: surpresa, tarifasCanceladas: sumiu, tarifasAlteradas: mudou,
        valorTarifasSurpresa: r2(vSurpresa)
      };

      l.diferenca = r2(liquidoRecebido - liquidoEsperado);
      l.difComissao = r2(l.comissaoCobrada - l.comissaoEsperada);
      l.difFrete = r2(l.freteCobrado - l.freteEsperado);
      l.status = classificar(l);
      l.explicacao = explicar(l);
      linhas.push(l);
    });

    // liberações sem venda no período carregado
    var opsVenda = new Set(mapaVendas.keys()); var orfas = 0, valorOrfas = 0;
    mapaLib.forEach(function (x, op) { if (!opsVenda.has(op)) { orfas++; valorOrfas += num(x[COL.liquido]); } });
    if (orfas) avisos.push(orfas + ' liberação(ões) sem venda correspondente no período carregado (R$ ' +
      r2(valorOrfas).toFixed(2) + ') — normalmente vendas de meses anteriores. Carregue o mês anterior para fechar 100%.');

    var kpis = calcularKpis(linhas);
    kpis.liberacoesOrfas = orfas;

    // catálogo de tarifas — para onde o dinheiro foi
    var catalogo = {};
    linhas.forEach(function (l) {
      l.tarifasLiberacao.forEach(function (t) {
        if (!catalogo[t.nome]) catalogo[t.nome] = { nome: t.nome, total: 0, ops: 0 };
        catalogo[t.nome].total += t.valor; catalogo[t.nome].ops++;
      });
    });
    var tarifasResumo = Object.keys(catalogo).map(function (k) {
      catalogo[k].total = r2(catalogo[k].total); return catalogo[k];
    }).sort(function (a, b) { return b.total - a.total; });

    var resultado = { linhas: linhas, kpis: kpis, avisos: avisos, tarifas: tarifasResumo, STATUS: ST };

    /* ============================================== CAMADA 3 (Mercado Pago) */
    if (mp && (mp.collection || mp.withdraw || mp.afterCollection)) {
      resultado.mercadoPago = conciliarMercadoPago(mp, linhas, avisos);
    }
    return resultado;
  }

  function fmt(n) { return Math.abs(n).toFixed(2).replace('.', ','); }

  function explicar(l) {
    if (l.status === ST.OK) return '';
    if (l.status === ST.PENDENTE) return 'Ainda sem liberação — dentro do prazo do ML.';
    if (l.status === ST.COMPETENCIA)
      return 'Item faturado em período anterior: no relatório de vendas sobrou só a linha de frete. Não é erro.';
    if (l.status === ST.DEVOLUCAO)
      return 'Liberação estornada por reclamação/devolução (R$ ' + l.reclamacoes.toFixed(2) +
             '). Confira se o produto voltou ao estoque antes de contestar.';
    if (l.status === ST.TARIFA) {
      var nomes = l.tarifasSurpresa.map(function (t) { return t.nome + ' (R$ ' + fmt(t.valor) + ')'; })
        .concat(l.tarifasAlteradas.map(function (t) { return t.nome + ' (+R$ ' + fmt(t.delta) + ')'; }));
      return 'Cobrança que não estava prevista na venda: ' + nomes.join(', ') + '.' +
        (l.opsNoMesmoEnvio > 1 ? ' Envio compartilhado com ' + (l.opsNoMesmoEnvio - 1) +
          ' outra(s) venda(s) — o ML cobrou o frete extra só nesta.' : '');
    }
    if (l.status === ST.MENOS)
      return 'Faltou R$ ' + fmt(l.diferenca) + ' e nenhuma tarifa, estorno ou devolução explica. Reclamar.';
    if (l.status === ST.MAIS) return 'Recebeu R$ ' + fmt(l.diferenca) + ' a mais que o previsto. Conferir.';
    return '';
  }

  function calcularKpis(linhas) {
    var k = { totalOperacoes: linhas.length, ok: 0, pendentes: 0, competencia: 0,
      tarifaNaoPrevista: 0, devolucoes: 0, aMenos: 0, aMais: 0,
      valorEsperado: 0, valorRecebido: 0,
      impactoTarifaNaoPrevista: 0, impactoDevolucoes: 0, impactoAMenos: 0, impactoAMais: 0,
      totalComissao: 0, totalFrete: 0 };
    linhas.forEach(function (l) {
      if (l.status === ST.OK) k.ok++;
      else if (l.status === ST.PENDENTE) k.pendentes++;
      else if (l.status === ST.COMPETENCIA) k.competencia++;
      else if (l.status === ST.TARIFA) { k.tarifaNaoPrevista++; k.impactoTarifaNaoPrevista += l.diferenca; }
      else if (l.status === ST.DEVOLUCAO) { k.devolucoes++; k.impactoDevolucoes += l.diferenca; }
      else if (l.status === ST.MENOS) { k.aMenos++; k.impactoAMenos += l.diferenca; }
      else if (l.status === ST.MAIS) { k.aMais++; k.impactoAMais += l.diferenca; }
      if (l.temLiberacao) { k.valorEsperado += l.liquidoEsperado; k.valorRecebido += l.liquidoRecebido; }
      k.totalComissao += l.comissaoCobrada; k.totalFrete += l.freteCobrado;
    });
    ['valorEsperado','valorRecebido','impactoTarifaNaoPrevista','impactoDevolucoes',
     'impactoAMenos','impactoAMais','totalComissao','totalFrete'].forEach(function (x) { k[x] = r2(k[x]); });
    var base = Math.max(1, k.totalOperacoes - k.pendentes);
    k.taxaConformidade = r2(100 * (k.ok + k.competencia) / base);
    return k;
  }

  /* ==================================================== CAMADA 3 — MP ===== */

  function conciliarMercadoPago(mp, linhas, avisos) {
    var col = mp.collection || [], wit = mp.withdraw || [], aft = mp.afterCollection || [];

    // recebimentos por operação
    var porOp = new Map();
    col.forEach(function (r) {
      var op = txt(r[MP.op]); if (!op) return;
      var acc = porOp.get(op);
      if (!acc) { acc = { op: op, liquido: 0, produto: 0, taxaMP: 0, taxaMkt: 0, frete: 0,
                          financiamento: 0, devolvido: 0, status: [], liberadoEm: '' }; porOp.set(op, acc); }
      var st = txt(r[MP.status]);
      acc.status.push(st);
      if (st === 'approved') {
        acc.liquido += num(r[MP.liquido]); acc.produto += num(r[MP.valorProduto]);
        acc.taxaMP += num(r[MP.taxaMP]); acc.taxaMkt += num(r[MP.taxaMarketplace]);
        acc.frete += num(r[MP.frete]); acc.financiamento += num(r[MP.financiamento]);
      }
      acc.devolvido += num(r[MP.devolvido]);
      if (!acc.liberadoEm) acc.liberadoEm = txt(r[MP.dataLiberado]);
    });

    // cruza com as linhas da camada 1
    var casadas = 0, semMP = 0, divergentesMP = [];
    linhas.forEach(function (l) {
      var m = porOp.get(l.operacao);
      if (!m) { l.mpEncontrado = false; semMP++; return; }
      casadas++;
      l.mpEncontrado = true;
      l.mpLiquido = r2(m.liquido);
      l.mpProduto = r2(m.produto);
      l.mpTaxaMP = r2(m.taxaMP);
      l.mpTaxaMarketplace = r2(m.taxaMkt);
      l.mpFrete = r2(m.frete);
      l.mpFinanciamento = r2(m.financiamento);
      l.mpDevolvido = r2(m.devolvido);
      l.mpLiberadoEm = m.liberadoEm;
      l.mpStatus = m.status.join(',');
      // O Mercado Pago confirma o valor que o ML disse ter liberado?
      // ⚠️ Comparar com liquidoLIBERACAO, não com liquidoRecebido:
      // o relatório de cobranças do MP é por PAGAMENTO do comprador e não inclui
      // a "Liberação de envio" — ela cai no saldo como movimento separado.
      l.difMP = r2(m.liquido - l.liquidoLiberacao);
      if (Math.abs(l.difMP) > TOLERANCIA && l.temLiberacao && m.status.indexOf('approved') >= 0) {
        divergentesMP.push(l);
      }
    });

    // saques
    var saques = { total: 0, taxas: 0, quantidade: 0, aprovados: 0, linhas: [] };
    wit.forEach(function (r) {
      var v = num(r[MP.wValor]), t = num(r[MP.wTaxa]), st = txt(r[MP.wStatus]);
      saques.quantidade++;
      if (st === 'approved') { saques.aprovados++; saques.total += v; saques.taxas += t; }
      saques.linhas.push({ data: txt(r[MP.wData]), id: txt(r[MP.wId]), status: st,
                           valor: r2(v), taxa: r2(t), banco: txt(r[MP.wBanco]) });
    });
    saques.total = r2(saques.total); saques.taxas = r2(saques.taxas);

    // reclamações e devoluções
    var disputas = { claims: 0, refunds: 0, valorRetido: 0, valorTotal: 0, linhas: [] };
    aft.forEach(function (r) {
      var fluxo = txt(r[MP.aFluxo]), v = num(r[MP.aValor]);
      if (fluxo === 'claim') disputas.claims++; else if (fluxo === 'refund') disputas.refunds++;
      if (txt(r[MP.aRetido]).toLowerCase() === 'true') disputas.valorRetido += v;
      disputas.valorTotal += v;
      disputas.linhas.push({ fluxo: fluxo, data: txt(r[MP.aData]), operacao: txt(r[MP.aOp]),
        motivo: txt(r[MP.aMotivo]), status: txt(r[MP.aStatus]), valor: r2(v),
        retido: txt(r[MP.aRetido]).toLowerCase() === 'true' });
    });
    disputas.valorRetido = r2(disputas.valorRetido); disputas.valorTotal = r2(disputas.valorTotal);

    // recebimentos do MP sem venda correspondente no período do ML
    var opsML = new Set(linhas.map(function (l) { return l.operacao; }));
    var mpOrfas = 0, mpOrfasValor = 0;
    porOp.forEach(function (m, op) {
      if (!opsML.has(op)) { mpOrfas++; mpOrfasValor += m.liquido; }
    });

    if (semMP) avisos.push(semMP + ' venda(s) do ML sem recebimento correspondente no relatório do ' +
      'Mercado Pago carregado — confira se o período do MP cobre o mesmo intervalo.');
    if (mpOrfas) avisos.push(mpOrfas + ' recebimento(s) do Mercado Pago sem venda no período do ML (R$ ' +
      r2(mpOrfasValor).toFixed(2) + ').');

    var totalMP = 0; porOp.forEach(function (m) { totalMP += m.liquido; });

    return {
      operacoesCasadas: casadas,
      vendasSemRecebimento: semMP,
      recebimentosSemVenda: mpOrfas,
      totalRecebidoMP: r2(totalMP),
      divergenciasMP: divergentesMP.length,
      impactoMP: r2(divergentesMP.reduce(function (s, l) { return s + l.difMP; }, 0)),
      saques: saques,
      disputas: disputas
    };
  }

  return {
    conciliar: conciliar,
    parseTarifas: parseTarifas,
    STATUS: ST, COL: COL, MP: MP,
    TOLERANCIA: TOLERANCIA,
    HEADER_ROW: 2,       // relatórios do ML
    HEADER_ROW_MP: 0,    // relatórios do Mercado Pago
    _num: num
  };
});



// ============================================================
// CONCILIAÇÃO — UI
// ============================================================

var _concFiles = {}; // { vendas, liberacoes, collection, withdraw, afterCollection }
var _concResultado = null;

function concDrop(ev){ ev.preventDefault(); ev.stopPropagation(); concProcessFiles(ev.dataTransfer.files); }
function concDragOver(ev){ ev.preventDefault(); document.getElementById('conc-drop').classList.add('conc-over'); }
function concDragLeave(){ document.getElementById('conc-drop').classList.remove('conc-over'); }
function concPickFile(){ document.getElementById('conc-file-input').click(); }
function concFileChange(ev){ concProcessFiles(ev.target.files); ev.target.value=''; }

function concProcessFiles(files){
  if(!files||!files.length) return;
  Array.from(files).forEach(function(file){
    var reader = new FileReader();
    reader.onload = function(e){
      try{
        var wb = XLSX.read(e.target.result, {type:'array'});
        var ws = wb.Sheets[wb.SheetNames[0]];
        // Detecta tipo pelo cabeçalho da linha 2 (ML) ou 0 (MP)
        var raw0 = XLSX.utils.sheet_to_json(ws, {range:0, header:1, defval:''});
        var tipo = concDetectarTipo(raw0, file.name);
        if(!tipo){ concToast('Arquivo não reconhecido: ' + file.name, 'err'); return; }
        var headerRow = (tipo==='collection'||tipo==='withdraw'||tipo==='afterCollection') ? 0 : 2;
        var dados = XLSX.utils.sheet_to_json(ws, {range:headerRow, defval:''});
        _concFiles[tipo] = dados;
        concRenderArquivos();
        concToast('✓ ' + file.name + ' → ' + concTipoLabel(tipo), 'ok');
      }catch(err){ concToast('Erro ao ler ' + file.name + ': ' + err.message, 'err'); }
    };
    reader.readAsArrayBuffer(file);
  });
}

function concDetectarTipo(raw0, nome){
  // Linha 0 raw (sem header) para detectar pela assinatura de colunas
  var row2 = raw0[2] || [], row0 = raw0[0] || [];
  var cols2 = row2.join('|'), cols0 = row0.join('|');
  // ML: linha 2 tem "Número da operação"
  if(cols2.indexOf('Número da operação')>=0){
    if(cols2.indexOf('Valor bruto (=)')>=0 && nome.toLowerCase().indexOf('libera')>=0) return 'liberacoes';
    if(cols2.indexOf('Valor bruto (=)')>=0) return 'vendas';
  }
  // MP: linha 0
  if(cols0.indexOf('Número da venda no Mercado Livre')>=0) return 'collection';
  if(cols0.indexOf('Número da retirada')>=0 || cols0.indexOf('withdraw_id')>=0) return 'withdraw';
  if(cols0.indexOf('Fluxo (flow)')>=0) return 'afterCollection';
  // fallback por nome
  var n = nome.toLowerCase();
  if(n.indexOf('venda')>=0||n.indexOf('sale')>=0) return 'vendas';
  if(n.indexOf('liber')>=0||n.indexOf('release')>=0) return 'liberacoes';
  if(n.indexOf('collection')>=0||n.indexOf('cobran')>=0) return 'collection';
  if(n.indexOf('withdraw')>=0||n.indexOf('saque')>=0) return 'withdraw';
  if(n.indexOf('after')>=0||n.indexOf('reclama')>=0) return 'afterCollection';
  return null;
}

function concTipoLabel(t){
  return {vendas:'Conciliação por Vendas (ML)', liberacoes:'Conciliação por Liberações (ML)',
    collection:'Cobranças — collection (MP)', withdraw:'Saques — withdraw (MP)',
    afterCollection:'Reclamações — after_collection (MP)'}[t] || t;
}

function concRemoverArquivo(tipo){
  delete _concFiles[tipo];
  concRenderArquivos();
}

function concRenderArquivos(){
  var el = document.getElementById('conc-files-lista');
  if(!el) return;
  var tipos = ['vendas','liberacoes','collection','withdraw','afterCollection'];
  var labels = {vendas:'Vendas ML', liberacoes:'Liberações ML', collection:'Cobranças MP', withdraw:'Saques MP', afterCollection:'Reclamações MP'};
  var cores = {vendas:'#7c3aed44', liberacoes:'#16a34a44', collection:'#0891b244', withdraw:'#d9770644', afterCollection:'#dc262644'};
  el.innerHTML = tipos.map(function(t){
    var tem = !!_concFiles[t];
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">'
      +'<span style="width:10px;height:10px;border-radius:50%;background:'+(tem?'var(--in)':'var(--border)')+';flex-shrink:0"></span>'
      +'<span style="font-size:.76rem;color:'+(tem?'var(--text)':'var(--text4)')+';flex:1">'+labels[t]+'</span>'
      +(tem?'<button onclick="concRemoverArquivo(\''+t+'\')" style="background:none;border:none;color:var(--out);cursor:pointer;font-size:.8rem" title="Remover">×</button>':'')
      +'</div>';
  }).join('');
  // Habilitar botão conciliar
  var btn = document.getElementById('conc-btn');
  if(btn) btn.disabled = !(_concFiles.vendas && _concFiles.liberacoes);
}

function conciliarAgora(){
  if(!_concFiles.vendas||!_concFiles.liberacoes){ concToast('Carregue os dois relatórios do ML', 'err'); return; }
  var btn = document.getElementById('conc-btn');
  if(btn){ btn.disabled=true; btn.textContent='Processando...'; }
  setTimeout(function(){
    try{
      var mp = {};
      if(_concFiles.collection) mp.collection = _concFiles.collection;
      if(_concFiles.withdraw) mp.withdraw = _concFiles.withdraw;
      if(_concFiles.afterCollection) mp.afterCollection = _concFiles.afterCollection;
      _concResultado = ConciliacaoML.conciliar(_concFiles.vendas, _concFiles.liberacoes, Object.keys(mp).length?mp:null);
      concRenderResultado(_concResultado);
    }catch(err){
      concToast('Erro na conciliação: '+err.message,'err');
      console.error(err);
    }
    if(btn){ btn.disabled=false; btn.textContent='Conciliar agora'; }
  },50);
}

function concRenderResultado(r){
  var el = document.getElementById('conc-resultado');
  if(!el) return;
  el.style.display='block';

  var k = r.kpis;
  var ST = ConciliacaoML.STATUS;

  // KPIs
  function kpiCard(label, val, note, cor){
    return '<div class="card" style="padding:14px;text-align:center;border-color:'+(cor||'var(--border)')+'40">'
      +'<div style="font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text4);margin-bottom:4px">'+label+'</div>'
      +'<div style="font-family:Outfit,sans-serif;font-size:1.4rem;font-weight:800;color:'+(cor||'var(--text)')+'">'+val+'</div>'
      +(note?'<div style="font-size:.66rem;color:var(--text3);margin-top:2px">'+note+'</div>':'')
      +'</div>';
  }

  var kpis = document.getElementById('conc-kpis');
  if(kpis) kpis.innerHTML =
    kpiCard('Operações',''+k.totalOperacoes)+
    kpiCard('OK',''+k.ok,'conformidade '+k.taxaConformidade+'%','var(--in)')+
    kpiCard('Aguardando',''+k.pendentes,'prazo ML')+
    kpiCard('Tarifa não prevista',''+k.tarifaNaoPrevista,(k.impactoTarifaNaoPrevista?'−R$ '+Math.abs(k.impactoTarifaNaoPrevista).toFixed(2):''),'var(--text)')+
    kpiCard('Devoluções',''+k.devolucoes,(k.impactoDevolucoes?'−R$ '+Math.abs(k.impactoDevolucoes).toFixed(2):''),'var(--text)')+
    kpiCard('Recebeu a menos',''+k.aMenos,(k.impactoAMenos?'−R$ '+Math.abs(k.impactoAMenos).toFixed(2):''),'var(--out)')+
    kpiCard('Recebeu a mais',''+k.aMais,(k.impactoAMais?'+R$ '+k.impactoAMais.toFixed(2):''));

  // Avisos
  var avDiv = document.getElementById('conc-avisos');
  if(avDiv) avDiv.innerHTML = r.avisos.length
    ? r.avisos.map(function(a){ return '<div style="background:#d9770618;border:1px solid #d9770644;border-radius:8px;padding:8px 12px;font-size:.76rem;color:#fbbf24;margin-bottom:7px">⚠️ '+a+'</div>'; }).join('')
    : '';

  // Tarifas
  var tbT = document.getElementById('conc-tb-tarifas');
  if(tbT) tbT.innerHTML = r.tarifas.map(function(t){
    return '<tr><td style="text-align:left;font-size:.75rem;color:var(--text2)">'+t.nome+'</td>'
      +'<td style="font-size:.75rem;color:var(--text3)">'+t.ops+'</td>'
      +'<td style="font-size:.75rem;font-weight:700;color:var(--out)">−R$ '+t.total.toFixed(2).replace('.',',')+'</td></tr>';
  }).join('');

  // Mercado Pago
  var mpBox = document.getElementById('conc-mp-box');
  if(mpBox && r.mercadoPago){
    var mp = r.mercadoPago;
    mpBox.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">'
      +'<div style="background:var(--bg2);border-radius:8px;padding:10px;text-align:center"><div style="font-size:.62rem;color:var(--text4);margin-bottom:3px">OPERAÇÕES CASADAS</div><div style="font-size:1.1rem;font-weight:800;color:var(--in)">'+mp.operacoesCasadas+'</div></div>'
      +'<div style="background:var(--bg2);border-radius:8px;padding:10px;text-align:center"><div style="font-size:.62rem;color:var(--text4);margin-bottom:3px">DIVERGÊNCIAS MP</div><div style="font-size:1.1rem;font-weight:800;color:'+(mp.divergenciasMP?'var(--out)':'var(--in)')+'">'+mp.divergenciasMP+'</div></div>'
      +'</div>'
      +'<div style="font-size:.74rem;color:var(--text3);margin-bottom:5px">Saques: R$ '+mp.saques.total.toFixed(2)+' · '+mp.saques.aprovados+' aprovados</div>'
      +'<div style="font-size:.74rem;color:var(--text3)">Disputas: '+mp.disputas.claims+' reclamações · '+mp.disputas.refunds+' devoluções · Retido: R$ '+mp.disputas.valorRetido.toFixed(2)+'</div>';
  } else if(mpBox){
    mpBox.innerHTML = '<div style="font-size:.76rem;color:var(--text4)">Carregue os relatórios do Mercado Pago para ver esta camada.</div>';
  }

  // Renderizar tabela
  concRenderTabela(r.linhas, '');
}

var _concLinhasFiltradas = [];

function concRenderTabela(linhas, filtroStatus, filtroBusca){
  filtroStatus = filtroStatus||'';
  filtroBusca = (filtroBusca||'').toLowerCase();
  _concLinhasFiltradas = linhas.filter(function(l){
    if(filtroStatus && l.status!==filtroStatus) return false;
    if(filtroBusca && (l.operacao+l.item+l.sku).toLowerCase().indexOf(filtroBusca)<0) return false;
    return true;
  });

  var ST = ConciliacaoML.STATUS;
  var corStatus = {};
  corStatus[ST.OK]='background:#16a34a22;color:var(--in)';
  corStatus[ST.PENDENTE]='background:var(--bg2);color:var(--text4)';
  corStatus[ST.COMPETENCIA]='background:#2563eb22;color:#60a5fa';
  corStatus[ST.TARIFA]='background:#d9770622;color:#fbbf24';
  corStatus[ST.DEVOLUCAO]='background:#6B21A822;color:#c4b5fd';
  corStatus[ST.MENOS]='background:#dc262622;color:var(--out);font-weight:700';
  corStatus[ST.MAIS]='background:#0891b222;color:#22d3ee';

  function fmt(n){ return n===undefined||n===null?'—':(n>=0?'':'-')+'R$ '+Math.abs(n).toFixed(2).replace('.',','); }
  function fmtD(n){ return n===undefined?'—':(n>0.1?'<span style="color:var(--out)">+R$ '+n.toFixed(2).replace('.',',')+'</span>':n<-0.1?'<span style="color:var(--out)">−R$ '+Math.abs(n).toFixed(2).replace('.',',')+'</span>':'<span style="color:var(--in)">R$ 0,00</span>'); }

  var tbody = document.getElementById('conc-tbody');
  if(!tbody) return;

  if(!_concLinhasFiltradas.length){
    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;padding:20px;color:var(--text4)">Nenhum resultado</td></tr>';
  } else {
    tbody.innerHTML = _concLinhasFiltradas.map(function(l){
      return '<tr>'
        +'<td style="font-size:.72rem;color:var(--text2);white-space:nowrap">'+l.operacao+'</td>'
        +'<td style="font-size:.72rem;color:var(--text3);white-space:nowrap">'+(l.dataVenda?l.dataVenda.substring(0,10):'—')+'</td>'
        +'<td style="font-size:.72rem;color:var(--text);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+l.item+'">'+l.item+'</td>'
        +'<td style="font-size:.72rem;color:var(--text3)">'+l.sku+'</td>'
        +'<td style="font-size:.72rem">'+fmt(l.comissaoEsperada)+'</td>'
        +'<td style="font-size:.72rem">'+fmt(l.comissaoCobrada)+'</td>'
        +'<td style="font-size:.72rem">'+fmtD(l.difComissao)+'</td>'
        +'<td style="font-size:.72rem">'+fmt(l.freteEsperado)+'</td>'
        +'<td style="font-size:.72rem">'+fmt(l.freteCobrado)+'</td>'
        +'<td style="font-size:.72rem">'+fmtD(l.difFrete)+'</td>'
        +'<td style="font-size:.72rem;font-weight:600">'+fmt(l.liquidoEsperado)+'</td>'
        +'<td style="font-size:.72rem">'+fmt(l.liquidoLiberacao)+'</td>'
        +'<td style="font-size:.72rem">'+fmt(l.liquidoEnvio)+'</td>'
        +'<td style="font-size:.72rem;font-weight:600">'+fmt(l.liquidoRecebido)+'</td>'
        +'<td style="font-size:.72rem">'+fmtD(l.diferenca)+'</td>'
        +'<td style="font-size:.72rem"><span style="'+corStatus[l.status]+';padding:2px 8px;border-radius:20px;font-size:.68rem;white-space:nowrap">'+l.status+'</span></td>'
        +'<td style="font-size:.7rem;color:var(--text3);max-width:220px;white-space:normal">'+l.explicacao+'</td>'
        +'</tr>';
    }).join('');
  }

  var cnt = document.getElementById('conc-contagem');
  if(cnt) cnt.textContent = _concLinhasFiltradas.length + ' de ' + (_concResultado?_concResultado.linhas.length:0) + ' operações';
}

function concFiltrar(){
  if(!_concResultado) return;
  var st = (document.getElementById('conc-f-status')||{}).value||'';
  var busca = (document.getElementById('conc-f-busca')||{}).value||'';
  concRenderTabela(_concResultado.linhas, st, busca);
}

function concSoReclamar(){
  if(!_concResultado) return;
  if(document.getElementById('conc-f-status')) document.getElementById('conc-f-status').value=ConciliacaoML.STATUS.MENOS;
  concFiltrar();
}

function concExportarCSV(){
  if(!_concLinhasFiltradas||!_concLinhasFiltradas.length) return;
  var cabecalho = ['Operação','Data','Item','SKU','Com.Prevista','Com.Cobrada','ΔCom','FretePrevisto','FreteCobrado','ΔFrete','Liq.Previsto','Liberação','Lib.Envio','Liq.Recebido','Diferença','Status','Explicação'];
  var linhas = _concLinhasFiltradas.map(function(l){
    function n(v){ return v===undefined||v===null?'':v.toFixed(2).replace('.',','); }
    return [l.operacao,l.dataVenda?l.dataVenda.substring(0,10):'',l.item,l.sku,
      n(l.comissaoEsperada),n(l.comissaoCobrada),n(l.difComissao),
      n(l.freteEsperado),n(l.freteCobrado),n(l.difFrete),
      n(l.liquidoEsperado),n(l.liquidoLiberacao),n(l.liquidoEnvio),n(l.liquidoRecebido),n(l.diferenca),
      l.status,l.explicacao].map(function(v){ return '"'+(v||'').toString().replace(/"/g,'\"')+'"'; }).join(',');
  });
  var csv = '﻿' + [cabecalho.join(',')].concat(linhas).join('\n');
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'conciliacao_realecom.csv';
  a.click();
}

function concToast(msg, tipo){
  var c = document.getElementById('conc-toasts');
  if(!c) return;
  var d = document.createElement('div');
  d.style.cssText='padding:8px 14px;border-radius:8px;font-size:.78rem;font-weight:600;margin-bottom:6px;'
    +(tipo==='err'?'background:#dc262622;border:1px solid #dc262644;color:var(--out)':'background:#16a34a22;border:1px solid #16a34a44;color:var(--in)');
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 3500);
}


// ============================================================
// FINANCEIRO — entradas, saídas e contas fixas
// Lógica do racional original, adaptada ao design system da
// Calculadora e ao armazenamento isolado por usuário.
// ============================================================

const FIN_CATS = {
  ent: [
    {id:'lucro-loja', label:'Lucro Loja',   cor:'#16a34a'},
    {id:'mentoria',   label:'Mentoria',     cor:'#0891b2'},
    {id:'curso',      label:'Curso',        cor:'#7c3aed'},
    {id:'outros-ent', label:'Outros',       cor:'#6b7280'}
  ],
  sai: [
    {id:'despesa',    label:'Despesa',      cor:'#dc2626'},
    {id:'banco',      label:'Banco',        cor:'#d97706'},
    {id:'fornecedor', label:'Fornecedor',   cor:'#7c3aed'},
    {id:'sai-ment',   label:'Mentoria',     cor:'#0891b2'},
    {id:'outros-sai', label:'Outros',       cor:'#6b7280'}
  ]
};

const FIN_CONTAS = ['CC Sicoob','CC Itaú','CC Santander','CC STONE','CC Caixa',
                    'CC Mercado Pago','CC Nubank','Dinheiro','Outro'];

const FIN_MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

let _finMes  = {m:new Date().getMonth()+1, a:new Date().getFullYear()};
let _finAba  = 'lanc';       // 'lanc' | 'fix'
let _finDir  = 'ent';        // direção no modal
let _finCat  = null;
let _finLanc = [];
let _finFix  = [];
let _finCarregado = false;

// ---------- carga ----------
async function finInit(){
  if(_finCarregado){ finRender(); return; }
  _finLanc = await fbGet('financeiro_lanc','realecom_fin_lanc','[]');
  _finFix  = await fbGet('financeiro_fix','realecom_fin_fix','[]');
  _finCarregado = true;
  finPreencherSelects();
  finRender();
}

function finPreencherSelects(){
  const opts = '<option value="">Selecione...</option>' +
    FIN_CONTAS.map(c=>`<option>${c}</option>`).join('');
  ['fin-inp-conta','fin-fix-conta'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.innerHTML = opts;
  });
}

function finSalvarLanc(){ setCached('realecom_fin_lanc',_finLanc); fbSet('financeiro_lanc',_finLanc); }
function finSalvarFix(){  setCached('realecom_fin_fix',_finFix);   fbSet('financeiro_fix',_finFix); }

// ---------- helpers ----------
function finBrl(v){
  const abs = Math.abs(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  return (v<0?'−':'') + 'R$ ' + abs;
}
function finFmtData(iso){
  const d = new Date(iso+'T12:00:00');
  return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0');
}
function finMesRef(){ return _finMes.a+'-'+String(_finMes.m).padStart(2,'0'); }
function finLabelMes(){ return FIN_MESES[_finMes.m-1]+' '+_finMes.a; }

function finMudarMes(d){
  _finMes.m += d;
  if(_finMes.m>12){ _finMes.m=1;  _finMes.a++; }
  if(_finMes.m<1) { _finMes.m=12; _finMes.a--; }
  finRender();
}

function finLancDoMes(){
  return _finLanc.filter(l=>{
    const d = new Date(l.data+'T12:00:00');
    return d.getMonth()+1===_finMes.m && d.getFullYear()===_finMes.a;
  });
}

// Uma fixa conta no mês se já começou e (se for dívida) ainda não terminou
function finFixasAtivas(){
  const ref = finMesRef();
  return _finFix.filter(f=>{
    if(f.inicio && ref < f.inicio) return false;
    if(f.tipo==='divida' && f.termino && ref > f.termino) return false;
    return true;
  });
}

function finCatInfo(id){
  return [...FIN_CATS.ent,...FIN_CATS.sai].find(c=>c.id===id) || {label:id,cor:'#6b7280'};
}

// ---------- render ----------
function finRender(){
  const lbl = document.getElementById('fin-mes-label');
  if(lbl) lbl.textContent = finLabelMes();

  const todos = finLancDoMes();
  const ents  = todos.filter(l=>l.dir==='ent');
  const sais  = todos.filter(l=>l.dir==='sai');
  const totEnt = ents.reduce((s,l)=>s+l.val,0);
  const totSai = sais.reduce((s,l)=>s+l.val,0);
  const totFix = finFixasAtivas().reduce((s,f)=>s+f.val,0);
  const res    = totEnt - totSai - totFix;

  const set=(id,txt,cor)=>{ const e=document.getElementById(id); if(e){ e.textContent=txt; if(cor) e.style.color=cor; } };
  set('fin-res-valor', finBrl(res), res>=0?'var(--in)':'var(--out)');
  set('hd-fin-ent', finBrl(totEnt));
  set('hd-fin-sai', finBrl(-totSai));
  const hr=document.getElementById('hd-fin-res');
  if(hr){ hr.textContent=finBrl(res); hr.style.color = res>=0?'var(--in)':'var(--out)'; }
  pintarMarca('fin-res-valor');
  set('fin-res-ent', finBrl(totEnt), 'var(--in)');
  set('fin-res-sai', finBrl(-totSai), 'var(--out)');
  set('fin-res-fix', finBrl(-totFix), 'var(--text2)');

  finRenderLista(todos);
  finRenderFixas();
}

function finRenderLista(items){
  const el = document.getElementById('fin-lista');
  if(!el) return;
  const ordenados = [...items].sort((a,b)=> new Date(b.data)-new Date(a.data));
  if(!ordenados.length){
    el.innerHTML = '<div style="text-align:center;padding:36px 20px;color:var(--text4);font-size:.8rem">'
      +'Nenhum lançamento em '+finLabelMes()+'.<br>Clique em <strong style="color:var(--text2)">+ Novo lançamento</strong> para começar.</div>';
    return;
  }
  el.innerHTML = ordenados.map(l=>{
    const c = finCatInfo(l.cat);
    const cor = l.dir==='ent' ? 'var(--in)' : 'var(--out)';
    const sinal = l.dir==='ent' ? 1 : -1;
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:9px;margin-bottom:6px">'
      +'<span style="width:32px;height:32px;border-radius:8px;background:'+c.cor+'22;border:1px solid '+c.cor+'44;display:flex;align-items:center;justify-content:center;flex-shrink:0">'
        +'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="'+c.cor+'" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
        +(l.dir==='ent'?'<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>':'<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>')
        +'</svg></span>'
      +'<div style="flex:1;min-width:0">'
        +'<div style="font-size:.78rem;font-weight:700;color:var(--text)">'+c.label+'</div>'
        +'<div style="font-size:.68rem;color:var(--text4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(l.desc||l.conta||'—')+'</div>'
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0">'
        +'<div style="font-size:.85rem;font-weight:800;color:'+cor+'">'+finBrl(l.val*sinal)+'</div>'
        +'<div style="font-size:.64rem;color:var(--text4)">'+finFmtData(l.data)+'</div>'
      +'</div>'
      +'<button onclick="finExcluirLanc(\''+l.id+'\')" title="Excluir" style="background:none;border:none;color:var(--text4);cursor:pointer;padding:4px;font-size:.9rem;flex-shrink:0">×</button>'
      +'</div>';
  }).join('');
}

function finRenderFixas(){
  const el = document.getElementById('fin-lista-fixas');
  if(!el) return;
  const ativas = finFixasAtivas();
  const tot = document.getElementById('fin-total-fixas');
  if(tot) tot.textContent = finBrl(-ativas.reduce((s,f)=>s+f.val,0));

  if(!_finFix.length){
    el.innerHTML = '<div style="text-align:center;padding:36px 20px;color:var(--text4);font-size:.8rem">'
      +'Nenhuma conta fixa cadastrada.<br>Clique em <strong style="color:var(--text2)">+ Nova conta fixa</strong>.</div>';
    return;
  }
  el.innerHTML = _finFix.map(f=>{
    const ativa = ativas.includes(f);
    const badge = f.tipo==='divida'
      ? '<span style="background:#dc262622;color:var(--out);border-radius:20px;padding:1px 7px;font-size:.6rem;font-weight:700">Dívida</span>'
      : '<span style="background:#d9770622;color:#fbbf24;border-radius:20px;padding:1px 7px;font-size:.6rem;font-weight:700">Operacional</span>';
    const term = (f.tipo==='divida' && f.termino)
      ? 'até '+FIN_MESES[parseInt(f.termino.split('-')[1])-1].substring(0,3)+'/'+f.termino.split('-')[0]
      : 'recorrente';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:9px;margin-bottom:6px;opacity:'+(ativa?'1':'.45')+'">'
      +'<div style="min-width:0;flex:1">'
        +'<div style="font-size:.78rem;font-weight:700;color:var(--text);margin-bottom:3px">'+f.desc+'</div>'
        +'<div style="font-size:.66rem;color:var(--text4)">'+badge+' · '+term+' · dia '+(f.dia||'—')+' · '+(f.conta||'—')+'</div>'
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0;margin-left:10px">'
        +'<div style="font-size:.85rem;font-weight:800;color:var(--out)">'+finBrl(-f.val)+'</div>'
        +'<div style="font-size:.62rem;color:var(--text4);margin-top:2px">'+(ativa?'ativa este mês':'inativa')+'</div>'
      +'</div>'
      +'<button onclick="finExcluirFixa(\''+f.id+'\')" title="Remover" style="background:none;border:none;color:var(--text4);cursor:pointer;padding:4px;font-size:.9rem;flex-shrink:0;margin-left:6px">×</button>'
      +'</div>';
  }).join('');
}

// ---------- abas ----------
function finAba(aba){
  _finAba = aba;
  const secL = document.getElementById('fin-sec-lanc');
  const secF = document.getElementById('fin-sec-fix');
  if(secL) secL.style.display = aba==='lanc' ? 'block' : 'none';
  if(secF) secF.style.display = aba==='fix'  ? 'block' : 'none';
  const bL = document.getElementById('fin-aba-lanc');
  const bF = document.getElementById('fin-aba-fix');
  if(bL) bL.className = 'toggle-btn' + (aba==='lanc'?' active':'');
  if(bF) bF.className = 'toggle-btn' + (aba==='fix' ?' active':'');
}

// ---------- modal lançamento ----------
function finAbrirModal(){
  _finCat = null;
  ['fin-inp-val','fin-inp-desc'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
  const c = document.getElementById('fin-inp-conta'); if(c) c.value='';
  const d = document.getElementById('fin-inp-data');  if(d) d.value = new Date().toISOString().split('T')[0];
  finSetDir('ent');
  const ov = document.getElementById('fin-ov-lanc'); if(ov) ov.style.display='flex';
}

function finSetDir(d){
  _finDir = d; _finCat = null;
  const bE = document.getElementById('fin-tab-ent');
  const bS = document.getElementById('fin-tab-sai');
  if(bE){ bE.style.background = d==='ent'?'#16a34a22':'transparent'; bE.style.borderColor = d==='ent'?'#16a34a':'var(--border)'; bE.style.color = d==='ent'?'var(--in)':'var(--text4)'; }
  if(bS){ bS.style.background = d==='sai'?'#dc262622':'transparent'; bS.style.borderColor = d==='sai'?'#dc2626':'var(--border)'; bS.style.color = d==='sai'?'var(--out)':'var(--text4)'; }
  finRenderCats();
}

function finRenderCats(){
  const el = document.getElementById('fin-cats');
  if(!el) return;
  el.innerHTML = FIN_CATS[_finDir].map(c=>{
    const on = _finCat===c.id;
    return '<button onclick="finSelCat(\''+c.id+'\')" style="padding:9px 8px;border-radius:8px;border:1.5px solid '+(on?c.cor:'var(--border)')+';background:'+(on?c.cor+'18':'var(--input-bg)')+';color:'+(on?c.cor:'var(--text3)')+';font-size:.74rem;font-weight:700;cursor:pointer;font-family:inherit">'+c.label+'</button>';
  }).join('');
}

function finSelCat(id){ _finCat = id; finRenderCats(); }

function finSalvarLancamento(){
  if(!_finCat){ alert('Selecione a categoria.'); return; }
  const val = parseFloat((document.getElementById('fin-inp-val')||{}).value);
  if(!val || val<=0){ alert('Informe um valor válido.'); return; }
  const data = (document.getElementById('fin-inp-data')||{}).value;
  if(!data){ alert('Selecione a data.'); return; }

  _finLanc.push({
    id: Date.now().toString(),
    dir: _finDir, cat: _finCat, val: val,
    desc: ((document.getElementById('fin-inp-desc')||{}).value||'').trim(),
    conta: (document.getElementById('fin-inp-conta')||{}).value||'',
    data: data
  });
  finSalvarLanc();

  // vai para o mês do lançamento
  const d = new Date(data+'T12:00:00');
  _finMes = {m:d.getMonth()+1, a:d.getFullYear()};

  finFechar('fin-ov-lanc');
  finAba('lanc');
  finRender();
}

function finExcluirLanc(id){
  if(!confirm('Excluir este lançamento?')) return;
  _finLanc = _finLanc.filter(l=>l.id!==id);
  finSalvarLanc();
  finRender();
}

// ---------- modal fixa ----------
function finAbrirModalFixa(){
  ['fin-fix-desc','fin-fix-val','fin-fix-termino','fin-fix-dia'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
  const t = document.getElementById('fin-fix-tipo'); if(t) t.value='divida';
  const c = document.getElementById('fin-fix-conta'); if(c) c.value='';
  finToggleTermino();
  const ov = document.getElementById('fin-ov-fixa'); if(ov) ov.style.display='flex';
}

function finToggleTermino(){
  const t = document.getElementById('fin-fix-tipo');
  const campo = document.getElementById('fin-campo-termino');
  if(t && campo) campo.style.display = t.value==='divida' ? 'block' : 'none';
}

function finSalvarNovaFixa(){
  const desc = ((document.getElementById('fin-fix-desc')||{}).value||'').trim();
  const val  = parseFloat((document.getElementById('fin-fix-val')||{}).value);
  if(!desc || !val || val<=0){ alert('Preencha a descrição e o valor.'); return; }
  const tipo = (document.getElementById('fin-fix-tipo')||{}).value;
  _finFix.push({
    id: Date.now().toString(),
    desc: desc, val: val, tipo: tipo,
    termino: tipo==='divida' ? ((document.getElementById('fin-fix-termino')||{}).value||null) : null,
    dia: parseInt((document.getElementById('fin-fix-dia')||{}).value) || null,
    conta: (document.getElementById('fin-fix-conta')||{}).value||''
  });
  finSalvarFix();
  finFechar('fin-ov-fixa');
  finAba('fix');
  finRender();
}

function finExcluirFixa(id){
  if(!confirm('Remover esta conta fixa?')) return;
  _finFix = _finFix.filter(f=>f.id!==id);
  finSalvarFix();
  finRender();
}

// ---------- util ----------
function finFechar(id){ const e=document.getElementById(id); if(e) e.style.display='none'; }
function finFecharSeFora(ev,id){ if(ev.target.id===id) finFechar(id); }


// ============================================================
// RESULTADO — cabeçalho de destaque e barra de decomposição
// Lê de lastCalc e alimenta os elementos novos do painel.
// ============================================================
function renderResultadoHero(){
  if(!lastCalc) return;
  const L = lastCalc, S = id => document.getElementById(id);
  const set = (id, txt) => { const e = S(id); if(e) e.textContent = txt; };

  const preco   = L.preco   || 0;
  const custo   = L.custo   || 0;
  const frete   = L.frete   || 0;
  const ins     = L.ins     || 0;
  const precoML = L.precoML || 0;
  const qtd     = L.qtd     || 1;
  const pI = L.pI || 0, pC = L.pC || 0, pA = L.pA || 0, pM = L.pM || 0;
  const base = custo + frete + ins;

  // ---- payout dentro de cada card ----
  set('pc-lucro-un', fmt(L.payout || 0));
  set('pc-payout',   fmt(preco - preco*pC - preco*pA - frete));

  if(precoML > 0){
    const mLucro = precoML - base - precoML*pI - precoML*pC - precoML*pA;
    set('ml-lucro-un', fmt(mLucro));
    set('ml-payout',   fmt(precoML - precoML*pC - precoML*pA - frete));
  } else {
    set('ml-lucro-un', 'R$ —');
    set('ml-payout',   'R$ —');
  }

  // ---- preço de compra ideal ----
  const boxC = S('compra-box');
  const fator = 1 - pI - pC - pA - pM;
  const ebEco = S('compra-eco-lbl');
  if(precoML > 0 && fator > 0){
    const mLucro2 = precoML - base - precoML*pI - precoML*pC - precoML*pA;
    const hoje = S('compra-hoje');
    const eco  = S('compra-economia');

    if(precoML < preco){
      // ---- mercado paga MENOS: o alvo é negociar a compra ----
      const compraIdeal = precoML * fator - frete - ins;
      const dif = custo - compraIdeal;
      set('compra-titulo', 'Para vender a ' + fmt(precoML) + ' com ' + fmtP(pM*100) + ' de margem, compre por até');
      set('compra-valor', fmt(Math.max(compraIdeal, 0)));
      if(hoje){
        hoje.innerHTML = dif > 0.01
          ? 'Hoje você paga ' + fmt(custo) + ' — precisa negociar <b style="color:var(--out)">' + fmt(dif) + ' a menos</b> por unidade'
          : 'Hoje você paga ' + fmt(custo) + ' — já está no ponto';
      }
      if(ebEco) ebEco.textContent = 'Economia no lote';
      if(eco){
        eco.textContent = dif > 0 ? fmt(dif * qtd) : '—';
        eco.style.color = dif > 0 ? 'var(--in)' : 'var(--text4)';
      }
    } else {
      // ---- mercado paga MAIS: o ganho é o extra por unidade ----
      const extra = mLucro2 - (L.payout || 0);
      const margemReal = precoML > 0 ? (mLucro2 / precoML) * 100 : 0;
      const espaco = precoML - preco;
      set('compra-titulo', 'Vendendo a ' + fmt(precoML) + ', o preço do mercado, você ganha a mais');
      set('compra-valor', fmt(Math.max(extra, 0)));
      if(hoje){
        hoje.innerHTML = 'Margem real de <b style="color:var(--in)">' + fmtP(margemReal) + '</b> em vez de '
          + fmtP(pM*100) + ' · dá para baixar até ' + fmt(preco)
          + ' <span style="color:var(--text4)">(' + fmt(espaco) + ' de folga)</span>';
      }
      if(ebEco) ebEco.textContent = 'Ganho extra no lote';
      if(eco){
        eco.textContent = extra > 0 ? fmt(extra * qtd) : '—';
        eco.style.color = extra > 0 ? 'var(--in)' : 'var(--text4)';
      }
    }
    if(boxC) boxC.style.display = 'flex';
    pintarMarca('compra-valor');
  } else {
    if(boxC) boxC.style.display = 'none';
  }

  // ---- simulação de margens ----
  const corpo = S('sim-corpo'), boxS = S('sim-box');
  if(corpo && base > 0){
    const alvos = [0, .10, .15, .20];
    const atual = Math.round(pM * 100);
    corpo.innerHTML = alvos.map(function(m){
      const f = 1 - pI - pC - pA - m;
      if(f <= 0) return '';
      const p      = base / f;
      const lucro  = p * m;
      const payout = p - p*pC - p*pA - frete;
      const compra = precoML > 0 ? precoML * f - frete - ins : null;
      const eAtual = Math.round(m * 100) === atual;
      return '<tr' + (eAtual ? ' class="atual"' : '') + '>'
        + '<td><span class="mg-pill">' + Math.round(m*100) + ' %</span></td>'
        + '<td>' + fmt(p) + '</td>'
        + '<td' + (m === 0 ? ' style="color:var(--text4);font-weight:500"' : '') + '>' + fmt(lucro) + '</td>'
        + '<td>' + fmt(payout) + '</td>'
        + '<td>' + (compra !== null ? fmt(Math.max(compra,0)) : '<span style="color:var(--text4);font-weight:500">—</span>') + '</td>'
        + '</tr>';
    }).join('');
    set('sim-nota', precoML > 0
      ? 'A linha destacada é a margem que você escolheu. “Comprar por até” considera a venda no preço do mercado, ' + fmt(precoML) + '.'
      : 'A linha destacada é a margem que você escolheu. Informe o preço médio do mercado para ver quanto pagar no fornecedor.');
    if(boxS) boxS.style.display = 'block';
  } else if(boxS){
    boxS.style.display = 'none';
  }

  const painel = document.getElementById('right-result');
  if(painel){
    painel.classList.remove('r-go');
    void painel.offsetWidth;
    requestAnimationFrame(function(){ painel.classList.add('r-go'); });
  }
}

// Pinta o destaque direto no elemento, com prioridade máxima.
// Necessário porque o app escreve style.color inline nessas células.
function marcarAmarelo(ids){
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--mark').trim()    || '#F2D024';
  const fg = css.getPropertyValue('--mark-fg').trim() || '#1A1500';
  ids.forEach(function(id){
    const el = document.getElementById(id);
    if(!el || !el.textContent || el.textContent === '—') return;
    el.style.setProperty('background', bg, 'important');
    el.style.setProperty('color', fg, 'important');
    el.style.setProperty('-webkit-text-fill-color', fg, 'important');
    el.style.setProperty('padding', '3px 9px', 'important');
    el.style.setProperty('border-radius', '6px', 'important');
    el.style.setProperty('font-weight', '700', 'important');
    el.style.setProperty('display', 'inline-block', 'important');
  });
}



// Estatísticas do cabeçalho do calendário
function calStats(){
  const evs = getEventos();
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const hojeStr = hoje.toISOString().split('T')[0];
  const em7 = new Date(hoje.getTime() + 7*864e5);

  const noMes = evs.filter(function(e){
    const d = new Date(e.data+'T00:00:00');
    return d.getMonth()===calMes && d.getFullYear()===calAno;
  }).length;

  const prox = evs.filter(function(e){
    const d = new Date(e.data+'T00:00:00');
    return d >= hoje && d <= em7;
  }).length;

  const deHoje = evs.filter(function(e){ return e.data===hojeStr; }).length;

  const s = function(id, v){ const el=document.getElementById(id); if(el) el.textContent=v; };
  s('cal-st-mes', noMes);
  s('cal-st-prox', prox);
  s('cal-st-hoje', deHoje ? deHoje : '—');
}


// ============================================================
// CALENDÁRIO — menu de novo evento e chips de configuração
// ============================================================
function toggleMenuEvento(ev){
  if(ev) ev.stopPropagation();
  const m = document.getElementById('menu-evento');
  if(!m) return;
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
function fecharMenuEvento(){
  const m = document.getElementById('menu-evento');
  if(m) m.style.display = 'none';
}
document.addEventListener('click', function(e){
  const m = document.getElementById('menu-evento');
  if(m && m.style.display === 'block' && !e.target.closest('#menu-evento,#btn-novo-ev')) fecharMenuEvento();
});

// O banner do WhatsApp agora abre pelo chip
function toggleWppBanner(){
  const b = document.getElementById('wpp-banner');
  if(!b) return;
  const abrindo = b.style.display === 'none' || !b.style.display;
  b.style.display = abrindo ? 'block' : 'none';
  if(abrindo) carregarTelefoneWhatsApp();
}

// Estado visual dos chips
function calChips(){
  const tel = getCached('realecom_telefone','null');
  const dw = document.getElementById('chip-wpp-dot');
  const tw = document.getElementById('chip-wpp-txt');
  if(dw) dw.style.background = tel ? 'var(--in)' : 'var(--text4)';
  if(tw) tw.textContent = tel ? 'WhatsApp ativo' : 'WhatsApp';

  const dp = document.getElementById('chip-push-dot');
  const lp = document.getElementById('btn-push-label');
  const ok = ('Notification' in window) && Notification.permission === 'granted';
  const no = ('Notification' in window) && Notification.permission === 'denied';
  if(dp) dp.style.background = ok ? 'var(--in)' : no ? 'var(--out)' : 'var(--text4)';
  if(lp) lp.textContent = ok ? 'Notificações ativas' : no ? 'Notificações bloqueadas' : 'Notificações';
}


// Aplica o destaque amarelo com prioridade máxima (vence style inline)
function pintarMarca(id){
  const el = document.getElementById(id);
  if(!el || !el.textContent || el.textContent === '—') return;
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--mark').trim();
  const fg = cs.getPropertyValue('--mark-fg').trim();
  el.style.setProperty('background', bg, 'important');
  el.style.setProperty('color', fg, 'important');
  el.style.setProperty('-webkit-text-fill-color', fg, 'important');
  el.style.setProperty('padding', '3px 10px', 'important');
  el.style.setProperty('border-radius', '6px', 'important');
  el.style.setProperty('display', 'inline-block', 'important');
  el.style.setProperty('font-weight', '700', 'important');
}

// ============================================================
// CONTROLE DE VERSÃO — a versão vem do Firestore, gravada pelo
// botão "Atualizar app de todos" no painel admin.
// ============================================================
let _versaoConhecida = null;

async function checarVersao(){
  try{
    const db = await getDB();
    const doc = await db.collection('config').doc('app').get();
    if(!doc.exists) return;
    const v = doc.data().versao;
    if(!v) return;

    // primeira leitura: só memoriza
    if(_versaoConhecida === null){
      _versaoConhecida = v;
      const guardada = localStorage.getItem('realecom_versao');
      if(guardada && guardada !== v){
        localStorage.setItem('realecom_versao', v);
        return recarregarApp(v);
      }
      localStorage.setItem('realecom_versao', v);
      return;
    }
    if(v !== _versaoConhecida){
      _versaoConhecida = v;
      localStorage.setItem('realecom_versao', v);
      recarregarApp(v);
    }
  }catch(e){ /* offline ou sem permissão — segue normal */ }
}

async function recarregarApp(v){
  avisarAtualizacao();
  try{
    if('caches' in window){
      const nomes = await caches.keys();
      await Promise.all(nomes
        .filter(n => !n.includes('firebase') && !n.includes('firestore'))
        .map(n => caches.delete(n)));
    }
    if('serviceWorker' in navigator){
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs
        .filter(r => r.scope && !r.scope.includes('firebase-messaging'))
        .map(r => r.unregister().catch(()=>{})));
    }
  }catch(e){}
  setTimeout(function(){
    const u = new URL(location.href);
    u.searchParams.set('_v', v);
    location.replace(u.toString());
  }, 1800);
}

function avisarAtualizacao(){
  if(document.getElementById('aviso-versao')) return;
  const d = document.createElement('div');
  d.id = 'aviso-versao';
  d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:9999;'
    + 'background:var(--card);border:1px solid var(--border);border-radius:10px;padding:11px 18px;'
    + 'font-size:.8rem;font-weight:600;color:var(--text);box-shadow:0 10px 32px rgba(0,0,0,.3);'
    + 'display:flex;align-items:center;gap:9px;font-family:inherit';
  d.innerHTML = '<span style="width:14px;height:14px;border:2px solid var(--text4);border-top-color:var(--text);'
    + 'border-radius:50%;display:inline-block;animation:girar .7s linear infinite"></span>'
    + 'Atualizando para a versão mais recente…';
  document.body.appendChild(d);
  if(!document.getElementById('css-girar')){
    const s = document.createElement('style');
    s.id = 'css-girar';
    s.textContent = '@keyframes girar{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }
}

// checa ao entrar, ao voltar para a aba e a cada minuto
setTimeout(checarVersao, 2500);
document.addEventListener('visibilitychange', function(){ if(!document.hidden) checarVersao(); });
setInterval(checarVersao, 60000);


// ============================================================
// REDE DE SEGURANÇA — nenhum erro deve falhar em silêncio.
// Mostra um aviso visível na tela, junto com o log no console,
// para que qualquer travamento seja diagnosticável na hora.
// ============================================================
function mostrarAvisoSucesso(msg){
  let box = document.getElementById('sucesso-app-toast');
  if(!box){
    box = document.createElement('div');
    box.id = 'sucesso-app-toast';
    box.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);'
      + 'max-width:92vw;z-index:99999;background:var(--in-bg);border:1px solid var(--in-line);'
      + 'color:var(--in);border-radius:10px;padding:12px 16px;font-size:.82rem;'
      + 'font-weight:600;box-shadow:0 12px 34px rgba(0,0,0,.25);font-family:inherit;'
      + 'display:flex;align-items:center;gap:10px';
    document.body.appendChild(box);
  }
  box.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>'
    + '<span style="flex:1;color:var(--text)">' + msg + '</span>'
    + '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--text4);'
    + 'font-size:1rem;cursor:pointer;flex-shrink:0;line-height:1">×</button>';
  clearTimeout(box._timer);
  box._timer = setTimeout(() => { if(box.parentElement) box.remove(); }, 7000);
}

function mostrarErroTela(msg){
  let box = document.getElementById('erro-app-toast');
  if(!box){
    box = document.createElement('div');
    box.id = 'erro-app-toast';
    box.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);'
      + 'max-width:92vw;z-index:99999;background:#3D1512;border:1px solid #8A2E27;'
      + 'color:#FFD9D5;border-radius:10px;padding:12px 16px;font-size:.82rem;'
      + 'font-weight:600;box-shadow:0 12px 34px rgba(0,0,0,.4);font-family:inherit;'
      + 'display:flex;align-items:center;gap:10px';
    document.body.appendChild(box);
  }
  box.innerHTML = '<span style="font-size:1.1rem;flex-shrink:0">⚠️</span>'
    + '<span style="flex:1">' + msg + '</span>'
    + '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#FFD9D5;'
    + 'font-size:1rem;cursor:pointer;flex-shrink:0;line-height:1">×</button>';
  box.style.display = 'flex';
  clearTimeout(box._timer);
  box._timer = setTimeout(() => { if(box.parentElement) box.remove(); }, 9000);
}

// Captura qualquer erro não tratado em qualquer parte do app
window.addEventListener('error', function(ev){
  console.error('Erro não tratado:', ev.error || ev.message);
  mostrarErroTela('Algo deu errado: ' + (ev.message || 'erro desconhecido')
    + '. Recarregue a página se o problema continuar.');
});
window.addEventListener('unhandledrejection', function(ev){
  console.error('Promise rejeitada:', ev.reason);
  // Falhas de service worker (notificações antigas do domínio) não afetam o uso
  if(/ServiceWorker|service worker/i.test(String(ev.reason && (ev.reason.message||ev.reason)))) return;
  mostrarErroTela('Algo deu errado ao carregar dados. Recarregue a página se persistir.');
});

// ============================================================
// CENTRAL DE AULAS — dados e progresso
// Progresso salvo por conta via fbGet/fbSet (isolado por usuário,
// sincroniza entre dispositivos).
// ============================================================
const AULAS_MODULOS = [
  {
    badge: "BLOCO 1", cor: "#ea580c",
    titulo: "Estrutura", contagem: "16 aulas",
    grupos: [
      { nome: null, aulas: [
        { titulo: "Introdução", desc: "Abertura do curso e ponto de partida da jornada.", url: "https://drive.google.com/file/d/1QGcdDIs0qI2C7rSwKufturU_rS7zMHl9/view", tipo: 'video' },
        { titulo: "O Marketplace", desc: "Como funciona um marketplace e onde o Mercado Livre se encaixa.", url: "https://drive.google.com/file/d/1IdqJ7I89Mr6uhBtZDETZgX9rFNQy_MDI/view", tipo: 'video' },
        { titulo: "O Mercado Livre", desc: "Visão geral da plataforma — como ela pensa e como você deve pensar nela.", url: "https://drive.google.com/file/d/1Lf_zBamuQqWhp8W2coGyHUJ8N1r2hVu3/view", tipo: 'video' },
        { titulo: "O Varejo", desc: "Entendendo o jogo do varejo antes de entrar no Mercado Livre.", url: "https://drive.google.com/file/d/1YdwBPwX0ufV8n-M4GURqRzLn8gpHRAeB/view", tipo: 'video' },
        { titulo: "Objetivos", desc: "Definindo o que você quer alcançar no Mercado Livre.", url: "https://drive.google.com/file/d/1ooCM-1EJ_jj8fysNN0NyW9SP6DwMyn97/view", tipo: 'video' },
        { titulo: "Estrutura da Operação", desc: "Por que estrutura vem antes de produto — o mapa da base.", url: "https://drive.google.com/file/d/1_zbx6vZP0pj_wUH07ueXZLlxhgt3MhG5/view", tipo: 'video' },
        { titulo: "Alinhamento de Expectativas", desc: "Alinhando o que esperar do processo e do resultado.", url: "https://drive.google.com/file/d/1wmKUK7CpMD774XvqMfeKLJNimUws9lGp/view", tipo: 'video' },
        { titulo: "Entendendo o Caminho no Mercado Livre", desc: "O mapa geral da jornada dentro da plataforma.", url: "https://drive.google.com/file/d/1L-kBYNvwxBZDBo-7OmF1lWQOpLz96t6o/view", tipo: 'video' },
        { titulo: "Documentação e Organização", desc: "Inscrição estadual, certificado digital e como organizar tudo.", url: "https://drive.google.com/file/d/17cUr0RMp2ZPcO7lv2gd60-zBhlekNI_8/view", tipo: 'video' },
        { titulo: "Endereço Fiscal e Prep Center", desc: "Por que São Paulo e como o Prep Center entra na sua operação.", url: "https://drive.google.com/file/d/14ubnGqheRVKGxYanichMzhQr8tFLoIwi/view", tipo: 'video' },
        { titulo: "CNPJ", desc: "Enquadramento, CNAEs e o raciocínio pra montar a empresa certa.", url: "https://drive.google.com/file/d/1TBrPvcVds_pwqsJwJyO-PzJ54l1MKMw4/view", tipo: 'video' },
        { titulo: "Abrindo o MEI", desc: "Passo a passo prático para abrir o MEI.", url: "https://drive.google.com/file/d/1_qkzN6ig36ve6sGB_qvDIMYpwSvf_3yX/view", tipo: 'video' },
        { titulo: "Logísticas", desc: "Correios, Agências, Coleta, Flex e Full — as 5 modalidades explicadas.", url: "https://drive.google.com/file/d/13eTE2bZ2GodF7djAXrIvh-ZWKqYQWIo5/view", tipo: 'video' },
        { titulo: "Criando a Conta", desc: "Configuração da conta do Mercado Livre com mentalidade de empresa.", url: "https://drive.google.com/file/d/1MxS-iyJTk4q7yZZQCkscF97V_ngZbf2V/view", tipo: 'video' },
        { titulo: "Programa Decola", desc: "Reputação e o programa de aceleração do Mercado Livre.", url: "https://drive.google.com/file/d/1Go4c1-5PXHTLZ7BTCAuBX_8Vb1wKOZdc/view", tipo: 'video' },
        { titulo: "Criando Anúncio pra Ativar o Decola", desc: "Aplicando na prática o que ativa o programa de reputação.", url: "https://drive.google.com/file/d/1gA_q5XMocjzd_FDYTQTRRKoP4_5Ywqr2/view", tipo: 'video' },
      ]},
    ]
  },
  {
    badge: "BLOCO 2", cor: "#7c3aed",
    titulo: "O que Vender", contagem: "9 itens",
    grupos: [
      { nome: "Demanda", aulas: [
        { titulo: "Triângulo da Viabilidade — Demanda", desc: "Apresentação de apoio: premissas, indicadores e pesquisa de mercado.", url: "https://drive.google.com/file/d/1XskxK1YdCyj4oSL5wdQIssjS23qFBAQN/view", tipo: 'doc' },
        { titulo: "Introdução", desc: "Abertura do módulo de Demanda — o que você vai aprender a seguir.", url: "https://drive.google.com/file/d/1YqUQtSvaM1GjDfEFJXj-C7RRBfJLq54c/view", tipo: 'video' },
        { titulo: "Entendendo o que é Demanda", desc: "O conceito de demanda e por que ele decide se um produto vale a pena vender.", url: "https://drive.google.com/file/d/1e2XBPgn1dnHeD1fSM49Q6s1I-E1V_1M_/view", tipo: 'video' },
        { titulo: "Como Achar Fornecedores", desc: "Onde e como encontrar fornecedores confiáveis para o seu produto.", url: "https://drive.google.com/file/d/1tcbs4uAfpf2GWiIHmAJsIqRKp5PVUTNQ/view", tipo: 'video' },
        { titulo: "Prática de Demanda", desc: "Aplicando o conceito de demanda em produtos reais.", url: "https://drive.google.com/file/d/1_07MnoTAWL-kX0p2zpZ28SuDrrZ0la7r/view", tipo: 'video' },
      ]},
      { nome: "Pricing", aulas: [
        { titulo: "Precificação — Teoria", desc: "A teoria por trás da precificação antes de colocar a mão na massa.", url: "https://drive.google.com/file/d/13azgqD2OnD5bfd8bPhMRWS-uj7ZZE5mJ/view", tipo: 'video' },
        { titulo: "Pesquisa de Mercado Completa", desc: "Pesquisa de mercado aplicada à demanda e à precificação, na prática.", url: "https://drive.google.com/file/d/1P6kTa81oliI9hMdX16tIOvQlLivc8Dtc/view", tipo: 'video' },
        { titulo: "Pricing — Indicadores", desc: "Margem de contribuição, markup, ROI e lucro líquido.", url: "https://drive.google.com/file/d/1bA5FSr51k9ck4uU-3CBGNv8I7T18w8nB/view", tipo: 'doc' },
      ]},
      { nome: "Estratégia de Posicionamento", aulas: [
        { titulo: "Playbook — Estratégia e Posicionamento", desc: "Referência completa do Triângulo da Viabilidade — tamanho de mercado, dinâmica competitiva e estratégia.", url: "https://drive.google.com/file/d/1mhkXqPRKBeX8UJ7ItzXLy1NsDGGQTcyW/view", tipo: 'doc' },
      ]},
    ]
  },
  {
    badge: "BLOCO 3", cor: "#ea580c",
    titulo: "Como Vender", contagem: "5 aulas",
    grupos: [
      { nome: null, aulas: [
        { titulo: "Passo a Passo do Anúncio", desc: "O passo a passo para montar um anúncio no Mercado Livre.", url: "https://drive.google.com/file/d/11rA5vS7rpIslEC4r3-147VzV2u7LLlTK/view", tipo: 'video' },
        { titulo: "Anúncio Campeão", desc: "Como montar um anúncio pronto pra vender no Mercado Livre.", url: "https://drive.google.com/file/d/1LqBSIV-OQab2P_Qr5n3jBgS3xtbMdIWZ/view", tipo: 'video' },
        { titulo: "Execução, Ajuste, Medição", desc: "O ciclo de executar, ajustar e medir os resultados.", url: "https://drive.google.com/file/d/1ofoYDRdgNezYrQCGa83zim2_8g3AVVk_/view", tipo: 'video' },
        { titulo: "Acelerador Real", desc: "Conheça o Acelerador Real.", url: "https://drive.google.com/file/d/1fauitsrV3hGK6puqcq3xNmYA6GFIOqkN/view", tipo: 'video' },
        { titulo: "Finalização", desc: "Encerramento do curso.", url: "https://drive.google.com/file/d/1BJsVRK4QDWmPfaHE7d5Vf7dDwot6Ztc6/view", tipo: 'video' },
      ]},
    ]
  },
  {
    badge: "EXTRA", cor: "#7c3aed",
    titulo: "Material Complementar", contagem: "3 arquivos",
    grupos: [
      { nome: null, aulas: [
        { titulo: "Estudo de Produto", desc: "Planilha pra registrar demanda, viabilidade e ROI de cada produto avaliado.", url: "https://docs.google.com/spreadsheets/d/1XnrDxGatpjWR2DI1d56GhgFk3HVtxgx9j_KNozR5wyY/edit", tipo: 'sheet' },
        { titulo: "Lista de Fornecedores", desc: "Fornecedores por categoria — utilidades domésticas, decoração, ferramentas e mais.", url: "https://docs.google.com/spreadsheets/d/1-6lbjukQdxUin_Qz-Fq3BKM-0sUtNHPsguUuw41Am9M/edit", tipo: 'sheet' },
        { titulo: "Prompts de Imagem pra Anúncio", desc: "7 prompts prontos pra gerar as imagens do seu anúncio no Mercado Livre.", url: "https://drive.google.com/file/d/1NF2h9CtB9U0EJIK8gR3TIzF-bDtlLqgk/view", tipo: 'doc' },
      ]},
    ]
  },
];

let _aulasAssistidas = [];
let _aulasCarregadas = false;
let _aulasAbertos = {}; // { indiceModulo: true/false } — estado de expandido/fechado

// Arquivos do Drive que foram reenviados com ID novo: o progresso do ID antigo passa para o novo.
const AULAS_ALIASES = {
  '1PiRMRnLPAAaBvW2PPrn_y_yjvoiisGJ0': '1LqBSIV-OQab2P_Qr5n3jBgS3xtbMdIWZ',
  // vídeo antigo de Pricing foi apagado; quem já tinha assistido ganha
  // crédito automático no vídeo que o substitui (mesmo conteúdo, só mudou de pasta)
  '1K1h18Rivr0adC9Q3HeeUdenkKHbww2tI': '1P6kTa81oliI9hMdX16tIOvQlLivc8Dtc'
};

// Identificador estável de cada aula: o ID do arquivo no Drive.
// Assim o progresso não se perde se o formato do link mudar ou se um vídeo for reenviado.
function _aulaId(url){
  const m = String(url).match(/\/d\/([A-Za-z0-9_-]+)/);
  const id = m ? m[1] : String(url);
  return AULAS_ALIASES[id] || id;
}

async function renderAulas(){
  const el = document.getElementById('aulas-content');
  if(!el) return;
  if(!_aulasCarregadas){
    el.innerHTML = '<div style="text-align:center;padding:44px;color:var(--text4);font-size:.8rem">Carregando…</div>';
    const _salvo = await fbGet('aulas_progresso','realecom_aulas_progresso','[]');
    // converte progresso antigo (link inteiro) para o ID do arquivo e remove repetidos
    _aulasAssistidas = Array.from(new Set((Array.isArray(_salvo) ? _salvo : []).map(_aulaId)));
    _aulasCarregadas = true;
    // abre o primeiro módulo que ainda não foi 100% concluído
    AULAS_MODULOS.forEach((m, i) => {
      const total = m.grupos.reduce((s,g)=>s+g.aulas.length,0);
      const feitas = m.grupos.reduce((s,g)=>s+g.aulas.filter(a=>_aulasAssistidas.includes(_aulaId(a.url))).length,0);
      if(!(i in _aulasAbertos)) _aulasAbertos[i] = feitas < total && !AULAS_MODULOS.slice(0,i).some((mm,ii)=>{
        const t2=mm.grupos.reduce((s,g)=>s+g.aulas.length,0), f2=mm.grupos.reduce((s,g)=>s+g.aulas.filter(a=>_aulasAssistidas.includes(_aulaId(a.url))).length,0);
        return f2<t2;
      });
    });
  }
  _renderAulasDom();
  _atualizarStatsAulas();
}

function _iconeAula(tipo){
  if(tipo==='video') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  if(tipo==='sheet') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/><line x1="15" y1="9" x2="15" y2="21"/></svg>';
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>';
}

function _renderAulasDom(){
  const el = document.getElementById('aulas-content');
  if(!el) return;

  const html = AULAS_MODULOS.map((m, mi) => {
    const total = m.grupos.reduce((s,g)=>s+g.aulas.length,0);
    const feitas = m.grupos.reduce((s,g)=>s+g.aulas.filter(a=>_aulasAssistidas.includes(_aulaId(a.url))).length,0);
    const pct = total>0 ? Math.round(feitas/total*100) : 0;
    const aberto = !!_aulasAbertos[mi];

    const gruposHtml = m.grupos.map(g => {
      const itensHtml = g.aulas.map(a => {
        const assistida = _aulasAssistidas.includes(_aulaId(a.url));
        return `<div class="aula-item${assistida?' assistida':''}">
          <div class="aula-check" data-url="${a.url.replace(/"/g,'&quot;')}" onclick="toggleAulaAssistida(this.dataset.url)" title="${assistida?'Marcar como não assistida':'Marcar como assistida'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div class="aula-icon">${_iconeAula(a.tipo)}</div>
          <a class="aula-corpo" href="${a.url}" target="_blank" rel="noopener" style="text-decoration:none">
            <div class="aula-titulo">${a.titulo}</div>
            <div class="aula-desc">${a.desc}</div>
          </a>
          <svg class="aula-abrir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </div>`;
      }).join('');
      const cabecalhoGrupo = g.nome ? `<div class="aula-subgrupo-titulo">${g.nome}</div>` : '';
      return cabecalhoGrupo + itensHtml;
    }).join('');

    return `<div class="aula-modulo${aberto?' aberto':''}">
      <div class="aula-modulo-header" onclick="toggleAulaModulo(${mi})">
        <span class="aula-badge" style="background:${m.cor}"></span>
        <div style="flex:1;min-width:0">
          <div class="aula-modulo-titulo">${m.titulo}</div>
          <div class="aula-modulo-sub">${m.badge} · ${m.contagem}</div>
        </div>
        <span class="aula-modulo-progresso">${feitas}/${total}</span>
        <svg class="aula-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="aula-modulo-bar"><div class="aula-modulo-bar-fill" style="width:${pct}%"></div></div>
      <div class="aula-modulo-conteudo">${gruposHtml}</div>
    </div>`;
  }).join('');

  el.innerHTML = html;
}

function toggleAulaModulo(mi){
  _aulasAbertos[mi] = !_aulasAbertos[mi];
  _renderAulasDom();
}

async function toggleAulaAssistida(url){
  const id = _aulaId(url);
  const idx = _aulasAssistidas.indexOf(id);
  if(idx === -1) _aulasAssistidas.push(id);
  else _aulasAssistidas.splice(idx, 1);
  setCached('realecom_aulas_progresso', _aulasAssistidas);
  fbSet('aulas_progresso', _aulasAssistidas);
  _renderAulasDom();
  _atualizarStatsAulas();
}

function _atualizarStatsAulas(){
  const todasAulas = [];
  AULAS_MODULOS.forEach(m => m.grupos.forEach(g => g.aulas.forEach(a => todasAulas.push(a))));
  const total = todasAulas.length;
  const feitas = todasAulas.filter(a => _aulasAssistidas.includes(_aulaId(a.url))).length;
  const pct = total>0 ? Math.round(feitas/total*100) : 0;
  const proxima = todasAulas.find(a => !_aulasAssistidas.includes(_aulaId(a.url)));

  const set = (id, txt) => { const e = document.getElementById(id); if(e) e.textContent = txt; };
  set('aulas-st-feitas', feitas + ' de ' + total);
  set('aulas-st-pct', pct + '%');
  set('aulas-st-prox', proxima ? proxima.titulo : 'Curso concluído');

  const elPct = document.getElementById('aulas-st-pct');
  if(elPct){
    const cs = getComputedStyle(document.documentElement);
    elPct.style.setProperty('background', cs.getPropertyValue('--mark').trim(), 'important');
    elPct.style.setProperty('color', cs.getPropertyValue('--mark-fg').trim(), 'important');
    elPct.style.setProperty('-webkit-text-fill-color', cs.getPropertyValue('--mark-fg').trim(), 'important');
    elPct.style.setProperty('padding', '2px 9px', 'important');
    elPct.style.setProperty('border-radius', '6px', 'important');
    elPct.style.setProperty('display', 'inline-block', 'important');
  }
}

// ============================================================
// DADOS DA EXTENSÃO — preenche o Preço Médio ML a partir do
// botão "Enviar para a Calculadora" lido na página do Mercado Livre.
// Chega como parâmetro na URL: ?precoML=48.90&nome=...&ml=1
// ============================================================
function lerDadosDaExtensao(){
  return null; // extensão do navegador não faz parte deste produto
  try{
    const params = new URLSearchParams(location.search);
    if(params.get('ml') !== '1') return null;
    const preco = parseFloat((params.get('precoML')||'').replace(',', '.'));
    if(!preco || preco <= 0) return null;
    return { preco, nome: params.get('nome') || '' };
  }catch(e){ return null; }
}

function aplicarDadosDaExtensao(dados){
  try{
    const campo = document.getElementById('preco-ml');
    if(campo) campo.value = dados.preco.toFixed(2);

    mostrarAvisoSucesso(
      'Preço do concorrente carregado' + (dados.nome ? ' — "' + dados.nome + '"' : '')
      + ': ' + fmt(dados.preco) + '. Preencha o restante e calcule.'
    );

    // Limpa a URL para não repreencher se a página for recarregada
    window.history.replaceState({}, document.title, location.pathname);
  }catch(e){ console.warn('aplicarDadosDaExtensao:', e); }
}


// ============================================================
// MERCADO LIVRE — primeiro acesso (conexão obrigatória)
// ============================================================
let _pendenteEntrada = null;

function mostrarConexaoML(dados, pagina){
  _pendenteEntrada = { dados, pagina };
  const sb = document.getElementById('sidebar');
  if(sb) sb.style.display = 'none';
  const sub = document.getElementById('conectar-sub');
  if(sub && dados && dados.nome){
    sub.innerHTML = 'Olá, <strong>' + String(dados.nome).replace(/[<>&]/g,'') + '</strong>! Conecte sua loja para a Calculadora usar os dados reais nas análises.';
  }
  showPage('conectar', true);
  const codigo = lerRetornoML();
  if(codigo) concluirConexaoML(codigo);
}

function atualizarBotaoConectar(){
  const ok = document.getElementById('conectar-aceite').checked;
  const btn = document.getElementById('btn-conectar-ml');
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.5';
}

function iniciarConexaoML(){
  if(!document.getElementById('conectar-aceite').checked) return;
  const state = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  try{
    sessionStorage.setItem('ml_state', state);
    sessionStorage.setItem('ml_aceite', ML_CONSENTIMENTO_VERSAO);
  }catch(e){}
  const url = 'https://auth.mercadolivre.com.br/authorization'
    + '?response_type=code'
    + '&client_id=' + encodeURIComponent(ML_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(ML_REDIRECT_URI)
    + '&state=' + encodeURIComponent(state);
  location.href = url;
}

// Lê o retorno do Mercado Livre (a página /callback devolve ?ml_code=...&ml_state=...)
function lerRetornoML(){
  try{
    const params = new URLSearchParams(location.search);
    const code = params.get('ml_code');
    const erro = params.get('ml_error');
    if(!code && !erro) return null;
    window.history.replaceState({}, document.title, location.pathname);
    if(erro){ mostrarErroConexao('A conexão foi cancelada no Mercado Livre. Tente novamente.'); return null; }
    const esperado = sessionStorage.getItem('ml_state');
    if(!esperado || esperado !== params.get('ml_state')){
      mostrarErroConexao('Não foi possível validar o retorno do Mercado Livre. Tente novamente.');
      return null;
    }
    sessionStorage.removeItem('ml_state');
    return code;
  }catch(e){ return null; }
}

function mostrarErroConexao(msg){
  const el = document.getElementById('conectar-erro');
  if(el){ el.textContent = msg; el.style.display = 'block'; }
  const ld = document.getElementById('conectar-loading');
  if(ld) ld.style.display = 'none';
}

async function concluirConexaoML(code){
  const ld = document.getElementById('conectar-loading');
  const btn = document.getElementById('btn-conectar-ml');
  if(ld) ld.style.display = 'block';
  if(btn) btn.disabled = true;
  try{
    ensureFirebase();
    const fn = firebase.app().functions('southamerica-east1').httpsCallable('mlConectar');
    const versao = sessionStorage.getItem('ml_aceite') || ML_CONSENTIMENTO_VERSAO;
    const r = await fn({ code, redirect_uri: ML_REDIRECT_URI, consentimento: versao });
    sessionStorage.removeItem('ml_aceite');
    _mlConectado = true;
    registrarAtividade('ml_conectado');
    const pend = _pendenteEntrada || {};
    if(r && r.data && r.data.nickname) mostrarAvisoSucesso('Conta ' + r.data.nickname + ' conectada!');
    entrarNoApp(pend.dados || verificarSessao() || {}, 'home');
  }catch(e){
    console.warn('mlConectar:', e);
    mostrarErroConexao((e && e.message) || 'Não foi possível conectar. Tente novamente.');
    atualizarBotaoConectar();
  }
}
