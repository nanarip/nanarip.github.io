// ============================================================
// GARIMPO nana.rip
// Busca produtos na Shopee (API de afiliados) e no Mercado Livre,
// e manda os achados formatados pro seu Telegram — prontos pra
// você copiar e colar no array `products` do index.html.
//
// Este script não decide categoria/gênero por você de propósito:
// isso fica marcado como "?" pra você preencher com seu próprio
// julgamento antes de colar no site.
// ============================================================

const crypto = require('crypto');

// ---- credenciais (vêm dos GitHub Secrets, nunca ficam no código) ----
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ---- edite essa lista quando quiser mudar o que o robô procura ----
const KEYWORDS = [
  "vestido gótico",
  "moletom harajuku dark",
  "colar gótico prata",
  "coturno gótico",
  "saia xadrez punk",
  "pelúcia horror fofo",
  "chaveiro acrílico gótico",
  "mouse rgb preto aesthetic",
  "teclado mecânico gótico",
  "fone gamer rosa preto",
  "bolsa transparente y2k",
  "brinco cruz gótico"
];

const RESULTS_PER_KEYWORD = 2; // quantos itens buscar por palavra-chave, em cada loja
const MAX_TOTAL = 24;          // teto de mensagens enviadas por dia (proteção contra flood)

// ============================================================
// SHOPEE — API oficial de afiliados (GraphQL)
// ============================================================
const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";

function shopeeSignature(appId, timestamp, payload, secret){
  const base = appId + timestamp + payload + secret;
  return crypto.createHash('sha256').update(base).digest('hex');
}

async function buscarShopee(keyword){
  const query = `query Fetch($keyword:String,$page:Int,$limit:Int){
    productOfferV2(keyword:$keyword, page:$page, limit:$limit, sortType:2){
      nodes{
        itemId
        productName
        productLink
        offerLink
        imageUrl
        priceMin
        priceMax
        commissionRate
      }
    }
  }`;

  const body = JSON.stringify({
    query,
    variables: { keyword, page: 1, limit: RESULTS_PER_KEYWORD }
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = shopeeSignature(SHOPEE_APP_ID, timestamp, body, SHOPEE_SECRET);

  const res = await fetch(SHOPEE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
    },
    body
  });

  const json = await res.json();

  if(json.errors){
    console.error(`[Shopee] erro na busca por "${keyword}":`, JSON.stringify(json.errors));
    return [];
  }

  const nodes = json?.data?.productOfferV2?.nodes || [];
  return nodes.map(n => ({
    origem: 'Shopee',
    store: 'Shopee',
    article: 'na',
    title: n.productName,
    price: `R$ ${Number(n.priceMin).toFixed(2).replace('.', ',')}`,
    image: n.imageUrl,
    link: n.offerLink || n.productLink
  }));
}

// ============================================================
// MERCADO LIVRE — API pública (sem necessidade de credencial)
// Atenção: essa API devolve o link comum do produto, não o link
// de afiliado. O link de afiliado (meli.la) ainda precisa ser
// gerado manualmente no painel de afiliados do Mercado Livre —
// esse robô só economiza o tempo de GARIMPAR o produto, não a
// etapa de criar o link com sua comissão.
// ============================================================
async function buscarMercadoLivre(keyword){
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(keyword)}&limit=${RESULTS_PER_KEYWORD}`;
  const res = await fetch(url);
  const json = await res.json();

  const results = json?.results || [];
  return results.map(r => ({
    origem: 'Mercado Livre (link não é de afiliado — gere no painel)',
    store: 'Mercado Livre',
    article: 'no',
    title: r.title,
    price: `R$ ${Number(r.price).toFixed(2).replace('.', ',')}`,
    image: r.thumbnail,
    link: r.permalink
  }));
}

// ============================================================
// TELEGRAM
// ============================================================
function escapeHtml(str){
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function enviarTelegram(texto){
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    })
  });
  return res.json();
}

// manda a foto do produto com uma legenda curta (título + preço + loja).
// devolve o JSON de resposta do Telegram, pra dar pra checar se funcionou.
async function enviarTelegramFoto(imageUrl, legenda){
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      photo: imageUrl,
      caption: legenda,
      parse_mode: 'HTML'
    })
  });
  return res.json();
}

function montarLegenda(p){
  return `🦇 <b>${escapeHtml(p.title)}</b>\n💰 ${p.price} — ${escapeHtml(p.origem)}`;
}

function montarCodigo(p){
  const codigo = `{
    title: "${p.title.replace(/"/g, "'")}",
    price: "${p.price}",
    category: "?",
    genre: "?",
    store: "${p.store}",
    article: "${p.article}",
    image: "${p.image}",
    link: "${p.link}"
  },`;
  return `<pre>${escapeHtml(codigo)}</pre>`;
}

// mensagem "tudo junto", usada só como reserva caso o envio da foto falhe
// (ex: a loja bloqueou o Telegram de acessar aquela imagem)
function montarMensagemCompleta(p){
  return `${montarLegenda(p)}\n\n${montarCodigo(p)}`;
}

function esperar(ms){ return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// EXECUÇÃO
// ============================================================
async function main(){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.error("Faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID nos Secrets.");
    process.exit(1);
  }

  let achados = [];

  for(const kw of KEYWORDS){
    try{
      if(SHOPEE_APP_ID && SHOPEE_SECRET){
        const shopee = await buscarShopee(kw);
        achados.push(...shopee);
      }
    }catch(e){
      console.error(`[Shopee] falhou pra "${kw}":`, e.message);
    }

    try{
      const ml = await buscarMercadoLivre(kw);
      achados.push(...ml);
    }catch(e){
      console.error(`[Mercado Livre] falhou pra "${kw}":`, e.message);
    }
  }

  // remove duplicados por link
  const vistos = new Set();
  achados = achados.filter(p => {
    if(!p.link || vistos.has(p.link)) return false;
    vistos.add(p.link);
    return true;
  });

  achados = achados.slice(0, MAX_TOTAL);

  console.log(`Total de achados hoje: ${achados.length}`);

  if(achados.length === 0){
    await enviarTelegram("🦇 garimpo de hoje não encontrou nada novo. tenta ajustar as palavras-chave no script.");
    return;
  }

  await enviarTelegram(`🦇 <b>garimpo do dia</b> — ${achados.length} achados novos`);
  await esperar(600);

  for(const p of achados){
    let fotoOk = true;
    try{
      const resultado = await enviarTelegramFoto(p.image, montarLegenda(p));
      if(!resultado.ok){
        fotoOk = false;
        console.error(`[Telegram] falhou ao mandar foto de "${p.title}":`, JSON.stringify(resultado));
      }
    }catch(e){
      fotoOk = false;
      console.error(`[Telegram] erro ao mandar foto de "${p.title}":`, e.message);
    }

    await esperar(600);

    if(fotoOk){
      await enviarTelegram(montarCodigo(p));
    }else{
      // a foto não carregou (às vezes a loja bloqueia o Telegram de acessar a imagem) —
      // manda tudo junto em texto, pra você não perder o achado
      await enviarTelegram(montarMensagemCompleta(p));
    }

    await esperar(600); // evita bater no limite de envio do Telegram
  }
}

main().catch(e => {
  console.error("Erro geral:", e);
  process.exit(1);
});
