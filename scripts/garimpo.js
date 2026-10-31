// ============================================================
// GARIMPO nana.rip
// Busca produtos na Shopee (API de afiliados) e no Mercado Livre
// e manda os achados pro seu Telegram: foto + bloco de código
// pronto pra colar no array `products` do index.html.
//
// category e genre saem como "?" de propósito: essa decisão é sua.
//
// Anti-repetição: o robô guarda em scripts/vistos.json tudo que já
// mandou e pula esses produtos nos dias seguintes.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- credenciais (vêm dos GitHub Secrets, nunca ficam no código) ----
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ---- lista completa de buscas. edite à vontade ----
// O robô não usa todas por dia: ele gira pela lista (veja KEYWORDS_PER_DAY),
// então quanto maior e mais variada a lista, mais variado o garimpo.
const KEYWORDS = [
  // goth
  "vestido gótico", "blusa renda preta gótica", "corset gótico", "saia longa preta gótica",
  "coturno gótico", "colar cruz gótico", "choker veludo preto", "anel caveira prata",
  // pastel goth / yami kawaii
  "pastel goth roupa", "moletom kuromi", "bolsa coração preto rosa", "meia calça caveira rosa",
  "yami kawaii acessório", "presilha laço preto", "tiara orelha gato preto", "mochila pelúcia dark",
  // guro kawaii
  "pelúcia horror fofo", "bandagem curativo kawaii", "guro kawaii", "chaveiro acrílico gótico",
  // punk
  "saia xadrez punk", "calça corrente punk", "cinto spike punk", "jaqueta patches punk",
  // cyberpunk / cybergoth
  "moletom cyberpunk", "calça cargo tática preta", "óculos futurista", "cybergoth acessório",
  "luva fishnet", "bota plataforma preta",
  // cyber kawaii
  "y2k holográfico", "bolsa transparente y2k", "fone orelha de gato", "pixel art acessório",
  // electronics
  "mouse rgb preto", "teclado mecânico gótico", "keycap vermelho preto", "mousepad dark",
  "headset rosa preto", "fita led gabinete", "cooler rgb preto", "suporte headset rgb"
];

const KEYWORDS_PER_DAY = 10;   // quantas buscas por dia (gira pela lista acima)
const RESULTS_PER_KEYWORD = 2; // itens NOVOS por busca, em cada loja
const PAGE_SIZE = 20;          // quantos itens olhar por página antes de filtrar os já vistos
const MAX_PAGES = 6;           // até onde descer nas páginas procurando itens novos
const MAX_TOTAL = 20;          // teto de produtos enviados por dia

// ---- regra de entrada: só passa item com histórico de vendas e nota ----
const MIN_VENDAS = 50;  // vendas mínimas do item (Shopee e Mercado Livre)
const MIN_NOTA = 4.5;   // nota mínima, de 0 a 5 (só a Shopee informa)

const descartados = { semHistorico: 0 }; // quantos itens o corte barrou hoje
const errosShopee = [];                  // erros da API, avisados no Telegram

const VISTOS_PATH = path.join(__dirname, 'vistos.json');

// ============================================================
// MEMÓRIA DO QUE JÁ FOI ENVIADO
// ============================================================
function carregarVistos(){
  try{
    return new Set(JSON.parse(fs.readFileSync(VISTOS_PATH, 'utf8')));
  }catch(e){
    return new Set(); // primeira execução: arquivo ainda não existe
  }
}

function salvarVistos(vistos){
  const lista = [...vistos].slice(-3000); // guarda os 3000 mais recentes
  fs.writeFileSync(VISTOS_PATH, JSON.stringify(lista));
}

// ============================================================
// UTILIDADES
// ============================================================
function palavrasDoDia(){
  const dia = Math.floor(Date.now() / 86400000);
  const inicio = (dia * KEYWORDS_PER_DAY) % KEYWORDS.length;
  const lista = [];
  for(let i = 0; i < KEYWORDS_PER_DAY; i++){
    lista.push(KEYWORDS[(inicio + i) % KEYWORDS.length]);
  }
  return lista;
}

function embaralhar(arr){
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function formatarPreco(valor){
  const n = Number(valor);
  if(!isFinite(n) || n <= 0) return 'Ver preço no site';
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function esperar(ms){ return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// SHOPEE — API oficial de afiliados (GraphQL)
// ============================================================
const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";

function shopeeSignature(appId, timestamp, payload, secret){
  return crypto.createHash('sha256').update(appId + timestamp + payload + secret).digest('hex');
}

async function consultarShopee(keyword, page){
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
        sales
        ratingStar
        shopName
      }
    }
  }`;

  const body = JSON.stringify({ query, variables: { keyword, page, limit: PAGE_SIZE } });
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
    console.error(`[Shopee] erro na busca por "${keyword}" (página ${page}):`, JSON.stringify(json.errors));
    errosShopee.push(JSON.stringify(json.errors).slice(0, 300));
    return [];
  }
  return json?.data?.productOfferV2?.nodes || [];
}

async function buscarShopee(keyword, excluir){
  const novos = [];
  for(let page = 1; page <= MAX_PAGES && novos.length < RESULTS_PER_KEYWORD; page++){
    const nodes = await consultarShopee(keyword, page);
    for(const n of nodes){
      const key = `shopee:${n.itemId}`;
      if(excluir.has(key) || novos.length >= RESULTS_PER_KEYWORD) continue;
      const vendas = Number(n.sales);
      const nota = Number(n.ratingStar);
      if(!(vendas >= MIN_VENDAS) || !(nota >= MIN_NOTA)){ descartados.semHistorico++; continue; }
      excluir.add(key);
      novos.push({
        key,
        origem: 'Shopee',
        store: 'Shopee',
        article: 'na',
        title: n.productName,
        price: formatarPreco(n.priceMin),
        image: n.imageUrl,
        link: n.offerLink || n.productLink,
        vendas, nota, loja: n.shopName || ''
      });
    }
    if(nodes.length < PAGE_SIZE) break; // acabaram as páginas dessa busca
  }
  return novos;
}

// ============================================================
// MERCADO LIVRE — API pública
// Devolve o link comum do produto, não o de afiliado (meli.la).
// O link de afiliado continua sendo gerado no painel do ML.
// ============================================================
async function buscarMercadoLivre(keyword, excluir){
  const novos = [];
  for(let page = 0; page < MAX_PAGES && novos.length < RESULTS_PER_KEYWORD; page++){
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(keyword)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    const res = await fetch(url);
    if(!res.ok){
      console.error(`[Mercado Livre] HTTP ${res.status} na busca por "${keyword}"`);
      return novos;
    }
    const json = await res.json();
    const results = json?.results || [];
    for(const r of results){
      const key = `ml:${r.id}`;
      if(excluir.has(key) || novos.length >= RESULTS_PER_KEYWORD) continue;
      const vendas = Number(r.sold_quantity);
      if(!(vendas >= MIN_VENDAS)){ descartados.semHistorico++; continue; }
      excluir.add(key);
      novos.push({
        key,
        origem: 'Mercado Livre (link comum — gere o de afiliado no painel)',
        store: 'Mercado Livre',
        article: 'no',
        title: r.title,
        price: formatarPreco(r.price),
        image: String(r.thumbnail || '').replace('http://', 'https://'),
        link: r.permalink,
        vendas, nota: null, loja: ''
      });
    }
    if(results.length < PAGE_SIZE) break;
  }
  return novos;
}

// ============================================================
// TELEGRAM
// ============================================================
function escapeHtml(str){
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function enviarTelegram(texto){
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
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

async function enviarTelegramFoto(imageUrl, legenda){
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
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
  const prova = `+${p.vendas} vendidos` + (p.nota ? ` · ★ ${p.nota.toFixed(1)}` : '') + (p.loja ? ` · ${escapeHtml(p.loja)}` : '');
  return `🦇 <b>${escapeHtml(p.title)}</b>\n💰 ${p.price} — ${escapeHtml(p.origem)}\n🛒 ${prova}`;
}

function montarCodigo(p){
  const codigo = `{
    title: "${p.title.replace(/"/g, "'")}",
    price: "${p.price}",
    category: "?",
    genre: "?",
    porque: "",
    store: "${p.store}",
    article: "${p.article}",
    image: "${p.image}",
    link: "${p.link}"
  },`;
  return `<pre>${escapeHtml(codigo)}</pre>`;
}

function montarMensagemCompleta(p){
  return `${montarLegenda(p)}\n\n${montarCodigo(p)}`;
}

// ============================================================
// EXECUÇÃO
// ============================================================
async function main(){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.error("Faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID nos Secrets.");
    process.exit(1);
  }

  const vistos = carregarVistos();
  const excluir = new Set(vistos); // já enviados + já coletados nesta rodada
  const palavras = palavrasDoDia();
  console.log(`Buscas de hoje: ${palavras.join(' | ')}`);
  console.log(`Produtos já enviados antes: ${vistos.size}`);

  let achados = [];

  for(const kw of palavras){
    try{
      if(SHOPEE_APP_ID && SHOPEE_SECRET){
        achados.push(...await buscarShopee(kw, excluir));
      }
    }catch(e){
      console.error(`[Shopee] falhou pra "${kw}":`, e.message);
    }

    try{
      achados.push(...await buscarMercadoLivre(kw, excluir));
    }catch(e){
      console.error(`[Mercado Livre] falhou pra "${kw}":`, e.message);
    }
  }

  // embaralha pra o corte do teto diário não pegar sempre as mesmas buscas
  achados = embaralhar(achados).slice(0, MAX_TOTAL);
  console.log(`Total de achados novos hoje: ${achados.length}`);

  if(errosShopee.length){
    await enviarTelegram(`⚠️ a API da Shopee devolveu erro (${errosShopee.length}x). Primeiro erro: <code>${escapeHtml(errosShopee[0])}</code>`);
  }

  if(achados.length === 0){
    await enviarTelegram(`🦇 nada passou no corte de hoje (mín. ${MIN_VENDAS} vendas e nota ${MIN_NOTA}). Barrados por falta de histórico: ${descartados.semHistorico}. Ajuste KEYWORDS ou o corte no script.`);
    salvarVistos(vistos); // garante que scripts/vistos.json existe
    return;
  }

  await enviarTelegram(`🦇 <b>garimpo do dia</b> — ${achados.length} achados com histórico (barrados por falta dele: ${descartados.semHistorico})`);
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
      await enviarTelegram(montarMensagemCompleta(p));
    }

    vistos.add(p.key); // só marca como visto o que de fato foi enviado
    await esperar(600);
  }

  salvarVistos(vistos);
}

main().catch(e => {
  console.error("Erro geral:", e);
  process.exit(1);
});
