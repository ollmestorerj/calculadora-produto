/**
 * Calculadora REAL (produto vendido na Kiwify) — Cloud Functions
 *
 *  kiwifyWebhook   → recebe as vendas da Kiwify, cria/libera/bloqueia o acesso
 *                    e manda o e-mail "Crie sua senha" para quem acabou de comprar
 *  mlConectar      → troca o código do OAuth do Mercado Livre pelos tokens e
 *                    salva a conexão da conta do cliente
 *  mlRenovarTokens → renova os tokens do ML de todos os clientes a cada 5 horas,
 *                    para a conexão nunca cair
 *
 * Segredos (configurar uma vez com o Firebase CLI):
 *   firebase functions:secrets:set KIWIFY_TOKEN
 *   firebase functions:secrets:set ML_CLIENT_SECRET
 */
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const KIWIFY_TOKEN = defineSecret("KIWIFY_TOKEN");
const ML_CLIENT_SECRET = defineSecret("ML_CLIENT_SECRET");
// Chave pública do app web (a mesma que está no app.js) — usada só para
// pedir ao Firebase que envie o e-mail de criação de senha.
const WEB_API_KEY = defineString("WEB_API_KEY");
const APP_URL = defineString("APP_URL", { default: "https://calculadorarealecom.com.br" });

const ML_CLIENT_ID = "3936370948601703";
const ML_TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const DIAS_TOLERANCIA = 3; // folga após o vencimento para a renovação cair

// ============================================================
// Utilidades
// ============================================================
function dataBR(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function somaDias(d, dias) {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + dias);
  return r;
}

function assinaturaValida(req, tokenBruto) {
  const recebida = String(req.query.signature || "").trim().toLowerCase();
  // Remove espaços/quebras de linha que entram ao colar o token no terminal
  const token = String(tokenBruto || "").trim();
  if (!recebida || !token) return false;
  const corpos = [];
  if (req.rawBody) corpos.push(req.rawBody);
  corpos.push(Buffer.from(JSON.stringify(req.body || {})));
  const calculadas = [];
  for (const corpo of corpos) {
    for (const alg of ["sha1", "sha256"]) {
      const esperada = crypto.createHmac(alg, token).update(corpo).digest("hex");
      calculadas.push(`${alg}:${esperada.slice(0, 8)}`);
      if (esperada.length === recebida.length &&
          crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recebida))) return true;
    }
  }
  // Diagnóstico (não expõe o token): ajuda a achar divergência de formato
  logger.warn("Assinatura não confere", {
    recebidaInicio: recebida.slice(0, 8),
    tamanhoRecebida: recebida.length,
    tamanhoToken: token.length,
    tamanhoTokenBruto: String(tokenBruto || "").length,
    tamanhoRawBody: req.rawBody ? req.rawBody.length : 0,
    calculadas,
  });
  return false;
}

// Classifica o evento da Kiwify em: liberar | bloquear | cancelar | ignorar
function classificar(p) {
  const evento = String(p.webhook_event_type || "").toLowerCase();
  const status = String(p.order_status || "").toLowerCase();
  if (["order_refunded", "chargeback"].includes(evento) ||
      ["refunded", "chargedback"].includes(status)) return "bloquear";
  if (evento === "subscription_canceled") return "cancelar";
  if (["order_approved", "subscription_renewed"].includes(evento) ||
      (!evento && status === "paid")) return "liberar";
  return "ignorar";
}

function detectarPlano(p) {
  const freq = String(p?.Subscription?.plan?.frequency || "").toLowerCase();
  const nome = [p?.Subscription?.plan?.name, p?.Product?.product_name, p?.Product?.name]
    .filter(Boolean).join(" ").toLowerCase();
  if (freq.includes("year") || freq.includes("annual") || nome.includes("anual")) return "anual";
  return "mensal";
}

function calcularValidade(p, plano) {
  // Usa só a parte da data (AAAA-MM-DD) ao meio-dia, para o fuso não mudar o dia
  const m = String(p?.Subscription?.next_payment || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return somaDias(new Date(+m[1], +m[2] - 1, +m[3], 12), DIAS_TOLERANCIA);
  const hoje = new Date();
  hoje.setHours(12, 0, 0, 0);
  return somaDias(hoje, (plano === "anual" ? 365 : 30) + DIAS_TOLERANCIA);
}

async function enviarEmailCriarSenha(email) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY.value()}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestType: "PASSWORD_RESET", email, continueUrl: APP_URL.value() }),
  });
  if (!resp.ok) throw new Error(`sendOobCode ${resp.status}: ${await resp.text()}`);
}

// ============================================================
// KIWIFY — webhook de vendas
// ============================================================
exports.kiwifyWebhook = onRequest({ secrets: [KIWIFY_TOKEN] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (!assinaturaValida(req, KIWIFY_TOKEN.value())) {
    logger.warn("Webhook Kiwify com assinatura inválida");
    return res.status(401).send("Assinatura inválida");
  }

  const p = req.body || {};
  const email = String(p?.Customer?.email || "").trim().toLowerCase();
  const nome = String(p?.Customer?.full_name || p?.Customer?.first_name || "").trim();
  const evento = String(p.webhook_event_type || p.order_status || "desconhecido").toLowerCase();
  const pedido = String(p.order_id || p.subscription_id || "sem_pedido");
  const acao = classificar(p);

  // Registro de todos os eventos (aparece no painel admin)
  const idEvento = `${pedido}_${evento}`.replace(/[^\w-]/g, "_");
  const refEvento = db.collection("kiwify_eventos").doc(idEvento);
  const jaProcessado = await refEvento.get();
  if (jaProcessado.exists && jaProcessado.data().processado) {
    return res.status(200).send("OK (repetido)");
  }
  await refEvento.set({
    email, nome, evento, acao, pedido,
    produto: p?.Product?.product_name || "",
    recebidoEm: FieldValue.serverTimestamp(),
    processado: false,
  }, { merge: true });

  if (!email) return res.status(200).send("OK (sem e-mail)");

  try {
    const refUsuario = db.collection("usuarios").doc(email);

    if (acao === "liberar") {
      const plano = detectarPlano(p);
      const validade = calcularValidade(p, plano);

      // Conta de login (Firebase Auth)
      let novo = false;
      try {
        await admin.auth().getUserByEmail(email);
      } catch (e) {
        if (e.code !== "auth/user-not-found") throw e;
        await admin.auth().createUser({ email, displayName: nome || undefined, emailVerified: true });
        novo = true;
      }

      await refUsuario.set({
        email,
        ...(nome ? { nome } : {}),
        ativo: true,
        validade: dataBR(validade),
        plano,
        origem: "kiwify",
        kiwify: {
          pedido,
          assinatura: p.subscription_id || null,
          status: "ativo",
          ultimoEvento: evento,
          atualizadoEm: FieldValue.serverTimestamp(),
        },
        ...(novo ? { criadoEm: FieldValue.serverTimestamp(), ml_conectado: false } : {}),
      }, { merge: true });

      if (novo) await enviarEmailCriarSenha(email);
      logger.info(`Acesso liberado: ${email} (${plano}, até ${dataBR(validade)}, novo=${novo})`);
    } else if (acao === "bloquear") {
      await refUsuario.set({
        ativo: false,
        kiwify: { status: evento, ultimoEvento: evento, atualizadoEm: FieldValue.serverTimestamp() },
      }, { merge: true });
      logger.info(`Acesso bloqueado (${evento}): ${email}`);
    } else if (acao === "cancelar") {
      // Assinatura cancelada: o cliente usa até o fim do período já pago
      await refUsuario.set({
        kiwify: { status: "cancelada", ultimoEvento: evento, atualizadoEm: FieldValue.serverTimestamp() },
      }, { merge: true });
      logger.info(`Assinatura cancelada (vale até a validade atual): ${email}`);
    }

    await refEvento.set({ processado: true }, { merge: true });
    return res.status(200).send("OK");
  } catch (err) {
    logger.error("Erro ao processar webhook Kiwify", err);
    await refEvento.set({ erro: String(err.message || err) }, { merge: true });
    return res.status(500).send("Erro interno");
  }
});

// ============================================================
// MERCADO LIVRE — conexão da conta do cliente
// ============================================================
async function salvarTokensML(email, tokenData) {
  await db.collection("usuarios").doc(email).collection("ml").doc("tokens").set({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    user_id: tokenData.user_id,
    expira_em: Timestamp.fromMillis(Date.now() + (tokenData.expires_in || 21600) * 1000),
    atualizadoEm: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function salvarPerfilML(email, accessToken) {
  const resp = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const u = await resp.json();
  const perfil = {
    id: u.id,
    nickname: u.nickname || "",
    nome: [u.first_name, u.last_name].filter(Boolean).join(" "),
    email_ml: u.email || "",
    cidade: u?.address?.city || "",
    estado: u?.address?.state || "",
    tipo_usuario: u.user_type || "",
    data_cadastro_ml: u.registration_date || "",
    reputacao: u.seller_reputation || null,
    status: u.status || null,
    atualizadoEm: FieldValue.serverTimestamp(),
  };
  await db.collection("usuarios").doc(email).collection("ml").doc("perfil").set(perfil, { merge: true });
  return perfil;
}

exports.mlConectar = onCall({ secrets: [ML_CLIENT_SECRET] }, async (request) => {
  const email = request.auth?.token?.email;
  if (!email) throw new HttpsError("unauthenticated", "Faça login para conectar sua conta.");
  const { code, redirect_uri: redirectUri, consentimento } = request.data || {};
  if (!code || !redirectUri) throw new HttpsError("invalid-argument", "Código de autorização ausente.");
  if (!consentimento) throw new HttpsError("failed-precondition", "É preciso aceitar os termos para conectar.");

  const resp = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET.value(),
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!resp.ok) {
    logger.warn("Falha na troca de token ML", await resp.text());
    throw new HttpsError("internal", "Não foi possível conectar ao Mercado Livre. Tente de novo.");
  }
  const tokenData = await resp.json();
  await salvarTokensML(email, tokenData);
  const perfil = await salvarPerfilML(email, tokenData.access_token);

  await db.collection("usuarios").doc(email).set({
    ml_conectado: true,
    ml_user_id: tokenData.user_id,
    ml_nickname: perfil?.nickname || "",
    ml_conectadoEm: FieldValue.serverTimestamp(),
    consentimento_ml: {
      aceito: true,
      versao: String(consentimento),
      aceitoEm: FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  return { ok: true, nickname: perfil?.nickname || "" };
});

exports.mlRenovarTokens = onSchedule(
  { schedule: "every 5 hours", timeZone: "America/Sao_Paulo", secrets: [ML_CLIENT_SECRET] },
  async () => {
    const conectados = await db.collection("usuarios").where("ml_conectado", "==", true).get();
    let ok = 0;
    let falhas = 0;
    for (const doc of conectados.docs) {
      const email = doc.id;
      try {
        const snap = await db.collection("usuarios").doc(email).collection("ml").doc("tokens").get();
        const refresh = snap.exists ? snap.data().refresh_token : null;
        if (!refresh) continue;
        const resp = await fetch(ML_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: ML_CLIENT_ID,
            client_secret: ML_CLIENT_SECRET.value(),
            refresh_token: refresh,
          }),
        });
        if (!resp.ok) {
          // Cliente revogou o acesso ou o token venceu: pede nova conexão
          await db.collection("usuarios").doc(email).set({ ml_conectado: false, ml_erro: `refresh ${resp.status}` }, { merge: true });
          falhas++;
          continue;
        }
        const tokenData = await resp.json();
        await salvarTokensML(email, tokenData);
        await salvarPerfilML(email, tokenData.access_token);
        ok++;
      } catch (e) {
        logger.error(`Renovação ML falhou para ${email}`, e);
        falhas++;
      }
    }
    logger.info(`Tokens ML renovados: ${ok} ok, ${falhas} falhas`);
  },
);
