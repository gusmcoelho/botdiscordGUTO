import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} from 'discord.js';
import { supabase } from './supabaseClient.js';
import dotenv from 'dotenv';

dotenv.config();

// Configurações das Variáveis de Ambiente
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID;
const SHOP_CHANNEL_ID = process.env.SHOP_CHANNEL_ID;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const LIVEPIX_CLIENT_ID = process.env.LIVEPIX_CLIENT_ID;
const LIVEPIX_CLIENT_SECRET = process.env.LIVEPIX_CLIENT_SECRET;

const activeOrdersLang = new Map();

// Mapeamento dinâmico de Banco de Dados
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'licenses';
const COL_KEY = process.env.COL_KEY || 'key';
const COL_EXPIRATION = process.env.COL_EXPIRATION || 'expires_at';
const CLAIMS_TABLE = process.env.CLAIMS_TABLE || 'discord_claims';

if (!DISCORD_TOKEN) {
  console.error('ERRO: A variável DISCORD_TOKEN não foi configurada no arquivo .env.');
  process.exit(1);
}

// Inicializa o cliente do Discord (Guilds, GuildMembers para cargos e eventos de entrar/sair)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// Variáveis de controle de throttling para o contador de membros (evita rate limits do Discord)
let lastCounterUpdate = 0;
let pendingCounterUpdate = null;

// Função geradora de chaves de teste (Formato: GUTO-5MIN-XXXXXX)
function generateTrialKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomPart = Array.from({ length: 6 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
  return `GUTO-5MIN-${randomPart}`;
}

// Função para atualizar o contador de membros (como uma categoria no topo do servidor)
async function updateMemberCounter(guild) {
  try {
    const memberCount = guild.memberCount;
    const categoryName = `─── 👥 ${memberCount} MEMBROS ───`;

    // Localizar se já existe uma categoria de contador
    let counterCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && (c.name.startsWith('─── 👥') || c.name.endsWith('MEMBROS ───'))
    );

    if (counterCategory) {
      if (counterCategory.name !== categoryName) {
        const now = Date.now();
        const cooldown = 5 * 60 * 1000; // Cooldown de 5 minutos (Discord limita renomeação de canais a 2 vezes por 10 min)

        if (now - lastCounterUpdate < cooldown) {
          if (!pendingCounterUpdate) {
            console.log(`[Counter] Atualização rápida detectada. Agendando atualização do contador para daqui a ${Math.round((cooldown - (now - lastCounterUpdate)) / 1000)}s...`);
            pendingCounterUpdate = setTimeout(async () => {
              pendingCounterUpdate = null;
              await updateMemberCounter(guild);
            }, cooldown - (now - lastCounterUpdate));
          }
          return;
        }

        lastCounterUpdate = now;
        await counterCategory.setName(categoryName);
        console.log(`[Counter] Nome da categoria atualizado para: ${categoryName}`);
      }
    } else {
      // Cria a categoria no topo do servidor (posição 0)
      counterCategory = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        position: 0,
        permissionOverwrites: [
          {
            id: guild.id, // @everyone (Somente visualização)
            deny: [PermissionFlagsBits.SendMessages],
          }
        ]
      });
      lastCounterUpdate = Date.now();
      console.log(`[Counter] Categoria do contador criada no topo: ${categoryName}`);
    }
  } catch (err) {
    console.error('[Counter] Erro ao atualizar contador de membros:', err);
  }
}

// Função para limpar canais antigos (com mais de 4 horas de criação)
async function cleanupOldTrialChannels() {
  if (!DISCORD_GUILD_ID) return;
  try {
    const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
    if (!guild) return;

    console.log('[Cleanup] Executando varredura de canais antigos...');
    const channels = await guild.channels.fetch();
    const now = Date.now();
    const fourHoursMs = 4 * 60 * 60 * 1000;

    for (const [id, channel] of channels) {
      if (channel && channel.type === ChannelType.GuildText && (channel.name.startsWith('trial-') || channel.name.startsWith('compra-'))) {
        const age = now - channel.createdTimestamp;
        if (age >= fourHoursMs) {
          console.log(`[Cleanup] Deletando canal expirado: ${channel.name} (Idade: ${Math.round(age / 1000 / 60)} minutos)`);
          await channel.delete('Canal de teste/compra expirou (limite de 4 horas atingido).').catch((err) => {
            console.error(`[Cleanup] Erro ao deletar o canal ${channel.name}:`, err);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup] Erro crítico ao limpar canais antigos:', err);
  }
}

// Função para entregar a chave comprada ao usuário
async function deliverKey(orderRow, lang = 'pt') {
  const { discord_id: discordId, discord_username: username, license_key: licenseKey, plan_id: planId } = orderRow;
  const texts = SHOP_LOCALE[lang] || SHOP_LOCALE.pt;

  const planName = texts.validityText[planId] || planId;
  const validity = texts.validityText[planId] || 'Vitalício';

  try {
    if (!DISCORD_GUILD_ID) {
      console.error('[Delivery] DISCORD_GUILD_ID não está configurado.');
      return;
    }

    const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
    if (!guild) {
      console.error(`[Delivery] Guild não encontrado no cache com o ID: ${DISCORD_GUILD_ID}`);
      return;
    }

    // 1. Obter ou criar a categoria "🛒 COMPRAS"
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === '🛒 COMPRAS'
    );
    if (!category) {
      try {
        category = await guild.channels.create({
          name: '🛒 COMPRAS',
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            {
              id: guild.id, // @everyone (Bloqueia visualização)
              deny: [PermissionFlagsBits.ViewChannel]
            }
          ]
        });
        console.log('[Delivery] Categoria "🛒 COMPRAS" criada com sucesso.');
      } catch (catErr) {
        console.error('[Delivery] Erro ao criar categoria "🛒 COMPRAS":', catErr);
      }
    }

    // 2. Criar o canal de texto privado compra-<username-sanitizado>
    const sanitizedUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '');
    const channelName = `${texts.channelPrefix}${sanitizedUsername}`;

    const privateChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category ? category.id : null,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone (Bloqueia visualização geral)
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: discordId, // Usuário comprador (Permite ver e ler histórico)
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        },
        {
          id: client.user.id, // O próprio Bot
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ]
    });

    console.log(`[Delivery] Canal privado de compra ${privateChannel.name} criado.`);

    // 3. Criar embed
    const deliveryEmbed = new EmbedBuilder()
      .setTitle(texts.deliveryTitle)
      .setDescription(texts.deliveryDesc(discordId))
      .setColor(0x00FF87) // Vibrant green
      .addFields(
        { name: texts.fieldKey, value: `\`\`\`${licenseKey}\`\`\`` },
        { name: texts.fieldPlan, value: planName, inline: true },
        { name: texts.fieldValidity, value: validity, inline: true }
      )
      .setFooter({ text: texts.footerClose })
      .setTimestamp();

    // Botão de fechar canal
    const closeButton = new ButtonBuilder()
      .setCustomId(`close_purchase_channel_${lang}`)
      .setLabel(texts.btnClose)
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');

    const row = new ActionRowBuilder().addComponents(closeButton);

    await privateChannel.send({
      content: `<@${discordId}>`,
      embeds: [deliveryEmbed],
      components: [row]
    });

    // 4. Tentar enviar a key via DM para redundância
    try {
      const user = await client.users.fetch(discordId);
      if (user) {
        const dmEmbed = new EmbedBuilder()
          .setTitle(texts.dmTitle)
          .setDescription(texts.dmDesc(planName))
          .setColor(0x00FF87)
          .addFields(
            { name: texts.fieldKey, value: `\`\`\`${licenseKey}\`\`\`` },
            { name: texts.fieldValidity, value: validity }
          )
          .setTimestamp();

        await user.send({ embeds: [dmEmbed] });
        console.log(`[Delivery] Key enviada com sucesso por DM para ${username}.`);
      }
    } catch (dmError) {
      console.warn(`[Delivery] Não foi possível enviar a key por DM para ${username}:`, dmError.message);
    }

    // 5. Agendar exclusão automática do canal em 4 horas (14.400.000 ms)
    setTimeout(async () => {
      try {
        const currentChannel = guild.channels.cache.get(privateChannel.id);
        if (currentChannel) {
          await currentChannel.delete('Limite de 4 horas do canal de compra atingido.');
          console.log(`[Cleanup] Canal de compra ${privateChannel.name} deletado automaticamente após 4 horas.`);
        }
      } catch (err) {
        // Silencia erro se já deletado
      }
    }, 4 * 60 * 60 * 1000);

  } catch (err) {
    console.error(`[Delivery] Erro crítico ao entregar key para o usuário ${username} (${discordId}):`, err);
  }
}

// --- Funções Auxiliares de Pagamento (LivePix e Stripe) ---

// Obter token OAuth2 para a API da LivePix
async function getLivePixToken() {
  const response = await fetch('https://oauth.livepix.gg/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      'grant_type': 'client_credentials',
      'client_id': LIVEPIX_CLIENT_ID,
      'client_secret': LIVEPIX_CLIENT_SECRET,
      'scope': 'payments'
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LivePix Auth Error: ${response.status} - ${text}`);
  }
  const data = await response.json();
  return data.access_token;
}

// Criar pagamento na API do LivePix (retorna reference e redirectUrl)
async function createLivePixPayment(amountCents) {
  const token = await getLivePixToken();
  const response = await fetch('https://api.livepix.gg/v2/payments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountCents,
      currency: 'BRL',
      redirectUrl: 'https://checkout.livepix.gg/success'
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LivePix Payment Error: ${response.status} - ${text}`);
  }
  const res = await response.json();
  return res.data;
}

// Verificar se um pagamento do LivePix foi recebido
async function checkLivePixPayment(reference) {
  try {
    const token = await getLivePixToken();
    const response = await fetch(`https://api.livepix.gg/v2/payments?reference=${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (!response.ok) {
      console.error(`[LivePix] Erro ao consultar pagamento ${reference}:`, response.status);
      return false;
    }
    const res = await response.json();
    return res.data && res.data.length > 0;
  } catch (err) {
    console.error(`[LivePix] Falha ao verificar pagamento ${reference}:`, err.message);
    return false;
  }
}

// Criar uma Session de Checkout da Stripe
async function createStripeSession(amountCents, planName, planId, discordId) {
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      'success_url': 'https://checkout.stripe.com/success',
      'cancel_url': 'https://checkout.stripe.com/cancel',
      'mode': 'payment',
      'line_items[0][price_data][currency]': 'brl',
      'line_items[0][price_data][product_data][name]': planName,
      'line_items[0][price_data][unit_amount]': amountCents.toString(),
      'line_items[0][quantity]': '1',
      'metadata[discord_id]': discordId,
      'metadata[plan_id]': planId
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stripe Session Error: ${response.status} - ${text}`);
  }
  return response.json();
}

// Verificar se uma Session da Stripe foi paga
async function checkStripePayment(sessionId) {
  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`
      }
    });
    if (!response.ok) {
      console.error(`[Stripe] Erro ao consultar session ${sessionId}:`, response.status);
      return false;
    }
    const session = await response.json();
    return session.payment_status === 'paid';
  } catch (err) {
    console.error(`[Stripe] Falha ao verificar pagamento ${sessionId}:`, err.message);
    return false;
  }
}

// Loop periódico para verificar pagamentos pendentes no Supabase
async function pollPendingOrders() {
  try {
    const { data: pendingOrders, error } = await supabase
      .from('bot_orders')
      .select('*')
      .eq('status', 'pending');

    if (error) {
      console.error('[Polling] Erro ao buscar ordens pendentes:', error);
      return;
    }

    if (!pendingOrders || pendingOrders.length === 0) return;

    for (const order of pendingOrders) {
      let isPaid = false;
      const orderId = order.id;

      try {
        if (order.method === 'pix') {
          isPaid = await checkLivePixPayment(order.payment_reference);
        } else {
          isPaid = await checkStripePayment(order.payment_reference);
        }

        if (isPaid) {
          console.log(`[Polling] Ordem ${orderId} confirmada como paga!`);
          
          // Gerar uma licença no formato GUTO-XXXX-XXXX-XXXX
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          const genSegment = () => Array.from({ length: 4 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
          const licenseKey = `GUTO-${genSegment()}-${genSegment()}-${genSegment()}`;

          // Atualizar a linha no banco de dados
          const { data: updatedOrder, error: updateError } = await supabase
            .from('bot_orders')
            .update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              license_key: licenseKey
            })
            .eq('id', orderId)
            .select()
            .single();

          if (updateError) {
            console.error(`[Polling] Erro ao atualizar ordem ${orderId} para paid:`, updateError);
            continue;
          }

          // Obter idioma da memória ou padrão para 'pt'
          const lang = activeOrdersLang.get(orderId) || 'pt';
          activeOrdersLang.delete(orderId);

          // Entregar a key para o usuário no canal privado e DM
          await deliverKey(updatedOrder, lang);
        }
      } catch (orderErr) {
        console.error(`[Polling] Erro ao processar ordem ${orderId}:`, orderErr);
      }
    }
  } catch (err) {
    console.error('[Polling] Erro crítico no loop de consulta:', err);
  }
}

// Função para criar e atribuir cargos iniciais
async function setupServerRoles() {
  if (!DISCORD_GUILD_ID) return;
  try {
    const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
    if (!guild) return;

    console.log('[Roles] Verificando e configurando cargos...');

    // 1. Verificar/Criar cargo "Membros" (Roxo) e garantir que esteja destacado (hoist)
    let roleMembros = guild.roles.cache.find(r => r.name === 'Membros');
    if (!roleMembros) {
      roleMembros = await guild.roles.create({
        name: 'Membros',
        color: '#9B59B6', // Roxo
        hoist: true, // Exibir separadamente dos membros online na lista
        reason: 'Cargo inicial criado pelo bot'
      });
      console.log('[Roles] Cargo "Membros" criado com destaque.');
    } else if (!roleMembros.hoist) {
      await roleMembros.edit({ hoist: true });
      console.log('[Roles] Cargo "Membros" atualizado para ser exibido separadamente (hoist).');
    }

    // 2. Verificar/Criar cargo "Penguin Supremo" (Amarelo) e garantir que esteja destacado (hoist)
    let rolePenguin = guild.roles.cache.find(r => r.name === 'Penguin Supremo');
    if (!rolePenguin) {
      rolePenguin = await guild.roles.create({
        name: 'Penguin Supremo',
        color: '#F1C40F', // Amarelo
        hoist: true, // Exibir separadamente dos membros online na lista
        reason: 'Cargo especial criado pelo bot'
      });
      console.log('[Roles] Cargo "Penguin Supremo" criado com destaque.');
    } else if (!rolePenguin.hoist) {
      await rolePenguin.edit({ hoist: true });
      console.log('[Roles] Cargo "Penguin Supremo" atualizado para ser exibido separadamente (hoist).');
    }

    // 3. Verificar/Criar cargo "Bots" (Azul) e garantir que esteja destacado (hoist)
    let roleBots = guild.roles.cache.find(r => r.name === 'Bots');
    if (!roleBots) {
      roleBots = await guild.roles.create({
        name: 'Bots',
        color: '#3498DB', // Azul (Light Blue padrão Discord)
        hoist: true,
        reason: 'Cargo para identificar os bots do servidor'
      });
      console.log('[Roles] Cargo "Bots" criado com destaque.');
    } else if (!roleBots.hoist) {
      await roleBots.edit({ hoist: true });
      console.log('[Roles] Cargo "Bots" atualizado para ser exibido separadamente (hoist).');
    }

    // 4. Garantir programaticamente a ordem correta dos cargos na hierarquia:
    // Hierarquia pretendida: Penguin Supremo > Membros > Bots
    if (roleMembros.position <= roleBots.position) {
      try {
        await roleMembros.setPosition(roleBots.position + 1);
        console.log('[Roles] Cargo "Membros" posicionado acima do cargo "Bots".');
      } catch (e) {
        console.warn(`[Roles] Não foi possível posicionar Membros acima de Bots: ${e.message}`);
      }
    }
    if (rolePenguin.position <= roleMembros.position) {
      try {
        await rolePenguin.setPosition(roleMembros.position + 1);
        console.log('[Roles] Cargo "Penguin Supremo" posicionado acima do cargo "Membros".');
      } catch (posError) {
        console.warn(`[Roles] Aviso: Não foi possível reordenar Penguin Supremo acima de Membros (${posError.message}). Certifique-se de que o cargo do bot (GUTO Keys) esteja no topo das configurações do servidor.`);
      }
    }

    // 5. Atribuir os cargos corretos para todos que já estão no servidor
    console.log('[Roles] Verificando membros existentes para atribuição de tags...');
    const members = await guild.members.fetch();
    let countMembros = 0;
    let countBots = 0;

    for (const [id, member] of members) {
      if (member.user.bot) {
        // Se for um bot, recebe o cargo "Bots"
        if (!member.roles.cache.has(roleBots.id)) {
          await member.roles.add(roleBots).catch((err) => {
            console.error(`[Roles] Não foi possível dar o cargo Bots a ${member.user.tag}:`, err);
          });
          countBots++;
        }
      } else {
        // Se for um humano, recebe o cargo "Membros"
        if (!member.roles.cache.has(roleMembros.id)) {
          await member.roles.add(roleMembros).catch((err) => {
            console.error(`[Roles] Não foi possível dar o cargo Membros a ${member.user.tag}:`, err);
          });
          countMembros++;
        }
      }
    }

    if (countMembros > 0 || countBots > 0) {
      console.log(`[Roles] Atualização concluída: ${countMembros} novos cargos Membros e ${countBots} novos cargos Bots.`);
    } else {
      console.log('[Roles] Todos os usuários e bots atuais já possuem os respectivos cargos.');
    }

    // 6. Verificar/Criar cargos de idioma (English, Português, Türkçe)
    let roleEnglish = guild.roles.cache.find(r => r.name === 'English');
    if (!roleEnglish) {
      await guild.roles.create({
        name: 'English',
        color: '#3498DB', // Azul
        reason: 'Cargo de idioma English'
      }).then(() => console.log('[Roles] Cargo English criado.'))
        .catch(err => console.error('[Roles] Erro ao criar cargo English:', err));
    }

    let rolePortugues = guild.roles.cache.find(r => r.name === 'Português');
    if (!rolePortugues) {
      await guild.roles.create({
        name: 'Português',
        color: '#2ECC71', // Verde
        reason: 'Cargo de idioma Português'
      }).then(() => console.log('[Roles] Cargo Português criado.'))
        .catch(err => console.error('[Roles] Erro ao criar cargo Português:', err));
    }

    let roleTurkce = guild.roles.cache.find(r => r.name === 'Türkçe');
    if (!roleTurkce) {
      await guild.roles.create({
        name: 'Türkçe',
        color: '#E74C3C', // Vermelho
        reason: 'Cargo de idioma Türkçe'
      }).then(() => console.log('[Roles] Cargo Türkçe criado.'))
        .catch(err => console.error('[Roles] Erro ao criar cargo Türkçe:', err));
    }

  } catch (err) {
    console.error('[Roles] Erro ao configurar cargos no servidor:', err);
  }
}

// Evento: Bot pronto e carregado
client.once('ready', async () => {
  console.log(`[Bot] Conectado com sucesso como: ${client.user.tag}`);

  // Registrar comando de Setup no Servidor
  if (DISCORD_GUILD_ID) {
    try {
      const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
      if (guild) {
        // Registrar comandos
        await guild.commands.set([
          {
            name: 'setup-support',
            description: 'Envia o painel de resgate de key no canal de suporte'
          },
          {
            name: 'setup-shop',
            description: 'Envia o painel de compra de keys no canal de vendas'
          }
        ]);
        console.log(`[Bot] Comandos /setup-support e /setup-shop registrados com sucesso no servidor: ${guild.name}`);
        
        // Configurar e atribuir cargos
        await setupServerRoles();

        // Configurar / Atualizar o contador de membros no topo
        await updateMemberCounter(guild);

        // 1. Verificar/criar canal de vendas "shop"
        try {
          let shopChannel = guild.channels.cache.find(
            c => c.type === ChannelType.GuildText && c.name === 'shop'
          );
          if (!shopChannel) {
            shopChannel = await guild.channels.create({
              name: 'shop',
              type: ChannelType.GuildText,
              permissionOverwrites: [
                {
                  id: guild.id, // @everyone (Pode ver, ler histórico, mas NÃO enviar mensagens)
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                  deny: [PermissionFlagsBits.SendMessages]
                }
              ]
            });
            console.log('[Shop] Canal #shop criado com sucesso.');
          }

          // 2. Enviar o painel de compras no canal #shop caso ainda não tenha sido enviado
          const messages = await shopChannel.messages.fetch({ limit: 10 }).catch(() => null);
          const alreadySent = messages && messages.some(msg => msg.author.id === client.user.id && msg.embeds.some(e => e.title && e.title.includes('GUTO PINGO - Shop')));

          if (!alreadySent) {
            const shopEmbed = new EmbedBuilder()
              .setTitle('🛒 GUTO PINGO - Shop / Loja / Dükkan')
              .setDescription(
                '🇧🇷 **Português:**\n' +
                'Selecione seu idioma abaixo para comprar uma chave.\n\n' +
                '──────────────────────────\n\n' +
                '🇺🇸 **English:**\n' +
                'Select your language below to buy a key.\n\n' +
                '──────────────────────────\n\n' +
                '🇹🇷 **Türkçe:**\n' +
                'Anahtar satın almak için aşağıdan dilinizi seçin.'
              )
              .setColor(0x00FF87)
              .setFooter({ text: 'Guto Pingo Sales System' })
              .setTimestamp();

            const btnEn = new ButtonBuilder()
              .setCustomId('buy_lang_en')
              .setLabel('English')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🇺🇸');

            const btnPt = new ButtonBuilder()
              .setCustomId('buy_lang_pt')
              .setLabel('Português')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🇧🇷');

            const btnTr = new ButtonBuilder()
              .setCustomId('buy_lang_tr')
              .setLabel('Türkçe')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🇹🇷');

            const row = new ActionRowBuilder().addComponents(btnEn, btnPt, btnTr);

            await shopChannel.send({
              embeds: [shopEmbed],
              components: [row]
            });
            console.log('[Shop] Painel de vendas postado automaticamente no canal #shop.');
          }
        } catch (shopErr) {
          console.error('[Shop] Erro ao configurar canal #shop ou postar painel:', shopErr);
        }

        // Executar uma limpeza inicial de canais órfãos antigos ao ligar o bot
        await cleanupOldTrialChannels();

        // Agendar limpeza para rodar a cada 15 minutos
        setInterval(cleanupOldTrialChannels, 15 * 60 * 1000);

        // Agendar verificação de pagamentos a cada 10 segundos
        setInterval(pollPendingOrders, 10 * 1000);
      } else {
        console.warn(`[Bot] Aviso: Servidor com ID ${DISCORD_GUILD_ID} não foi encontrado no cache. Verifique se o bot está no servidor.`);
      }
    } catch (error) {
      console.error('[Bot] Erro ao registrar os comandos de barra:', error);
    }
  } else {
    console.warn('[Bot] Aviso: DISCORD_GUILD_ID não está configurado. O comando /setup-support não foi registrado.');
  }
});

// Evento: Quando um novo membro entra no servidor
client.on('guildMemberAdd', async (member) => {
  try {
    const guild = member.guild;

    if (member.user.bot) {
      // Se for bot, recebe o cargo "Bots"
      const roleBots = guild.roles.cache.find(r => r.name === 'Bots');
      if (roleBots) {
        await member.roles.add(roleBots);
        console.log(`[Roles] Novo bot ${member.user.tag} recebeu o cargo "Bots".`);
      }
    } else {
      // Se for humano, recebe o cargo "Membros"
      const roleMembros = guild.roles.cache.find(r => r.name === 'Membros');
      if (roleMembros) {
        await member.roles.add(roleMembros);
        console.log(`[Roles] Novo membro ${member.user.tag} recebeu o cargo "Membros".`);
      }
    }

    // Atualizar o contador de membros
    await updateMemberCounter(guild);
  } catch (err) {
    console.error(`[Roles/Counter] Erro no evento guildMemberAdd para ${member.user.tag}:`, err);
  }
});

// Evento: Quando um membro sai do servidor
client.on('guildMemberRemove', async (member) => {
  try {
    // Atualizar o contador de membros
    await updateMemberCounter(member.guild);
  } catch (err) {
    console.error(`[Counter] Erro no evento guildMemberRemove para ${member.user.tag}:`, err);
  }
});

// Evento: Tratamento de Interações (Comandos e Botões)
// Localized texts for languages: en, pt, tr
const LOCALE = {
  en: {
    alreadyClaimed: '⚠️ You have already claimed a trial key! The limit is only **1 key per person**.',
    claimsError: '❌ An error occurred while checking the claims table. Please ensure you created the `discord_claims` table in your Supabase.',
    insertError: '❌ Could not register your key in the licenses table. Check the column mapping in your .env file.',
    channelError: '❌ An error occurred while creating your private channel. Make sure the bot has the **Manage Channels** permission.',
    embedTitle: '🔑 Your Guto Trial Key!',
    embedDesc: (user) => `Hello ${user}, here is your temporary access key to test **Guto**!`,
    fieldKey: 'Your Key',
    fieldDuration: 'Duration',
    fieldDurationVal: '5 Minutes',
    fieldStatus: 'Status',
    fieldStatusVal: 'Starts after activation in the extension',
    embedFooter: 'This key is for exclusive use and expires 5 minutes after activation in the extension. This channel will close automatically in 4 hours.',
    closeLabel: 'Close Channel',
    successReply: (channel) => `✅ Your trial key was generated successfully! Enter your private channel to view it: ${channel}`,
    closeWarning: '🔒 This support channel will be closed and deleted in 5 seconds...'
  },
  pt: {
    alreadyClaimed: '⚠️ Você já resgatou a sua chave de teste anteriormente! O limite é de apenas **1 chave por pessoa**.',
    claimsError: '❌ Ocorreu um erro ao consultar o controle de resgates. Por favor, certifique-se de que criou a tabela `discord_claims` no seu Supabase.',
    insertError: '❌ Não foi possível registrar sua chave na tabela de licenças. Verifique o mapeamento das colunas no arquivo .env.',
    channelError: '❌ Ocorreu um erro ao criar seu canal privado. Certifique-se de que o bot possui a permissão de **Gerenciar Canais**.',
    embedTitle: '🔑 Sua Key de Teste do Guto!',
    embedDesc: (user) => `Olá ${user}, aqui está sua chave de acesso temporária para testar o **Guto**!`,
    fieldKey: 'Sua Chave',
    fieldDuration: 'Duração',
    fieldDurationVal: '5 Minutos',
    fieldStatus: 'Status',
    fieldStatusVal: 'Inicia após ativação na extensão',
    embedFooter: 'Esta chave é de uso exclusivo e expira 5 minutos após a ativação na extensão. Este canal fechará automaticamente em 4 horas.',
    closeLabel: 'Fechar Canal',
    successReply: (channel) => `✅ Sua chave de teste foi gerada com sucesso! Entre no seu canal privado para visualizá-la: ${channel}`,
    closeWarning: '🔒 Este canal de suporte será fechado e excluído em 5 segundos...'
  },
  tr: {
    alreadyClaimed: '⚠️ Daha önce deneme anahtarı aldınız! Limit kişi başı en fazla **1 anahtardır**.',
    claimsError: '❌ Talep tablosu kontrol edilirken bir hata oluştu. Lütfen Supabase\'inizde `discord_claims` tablosunu oluşturduğunuzdan emin olun.',
    insertError: '❌ Anahtarınız lisans tablosuna kaydedilemedi. .env dosyasındaki sütun eşleşmelerini kontrol edin.',
    channelError: '❌ Özel kanalınız oluşturulurken bir hata oluştu. Botun **Kanalları Yönet** yetkisine sahip olduğundan emin olun.',
    embedTitle: '🔑 Guto Deneme Anahtarınız!',
    embedDesc: (user) => `Merhaba ${user}, **Guto**'yu test etmeniz için geçici erişim anahtarınız burada!`,
    fieldKey: 'Anahtarınız',
    fieldDuration: 'Süre',
    fieldDurationVal: '5 Dakika',
    fieldStatus: 'Durum',
    fieldStatusVal: 'Uzantıda etkinleştirildikten sonra başlar',
    embedFooter: 'Bu anahtar kişiye özeldir ve uzantıda etkinleştirildikten 5 dakika sonra sona erer. Bu kanal 4 saat içinde otomatik olarak kapatılacaktır.',
    closeLabel: 'Kanalı Kapat',
    successReply: (channel) => `✅ Deneme anahtarınız başarıyla oluşturuldu! Görüntülemek için özel kanalınıza gidin: ${channel}`,
    closeWarning: '🔒 Bu destek kanalı 5 saniye içinde kapatılacak ve silinecektir...'
  }
};

const SHOP_LOCALE = {
  en: {
    choosePlan: '🛒 **Choose your Plan**',
    plan1Day: '1 Day - R$ 20',
    plan1Week: '1 Week - R$ 45',
    plan30Days: '30 Days - R$ 100',
    planLifetime: 'Lifetime - R$ 169,99',
    paymentMethod: 'How would you like to pay?',
    pixLabel: 'PIX (Brazil Only)',
    cardLabel: 'Credit Card',
    waitPayment: 'Waiting for payment confirmation...',
    paymentInstructions: '⚠️ **After payment, your key will be delivered automatically in a private channel on this server. Do not close Discord!**',
    btnPayLabel: 'Go to Payment',
    errorBilling: '❌ An error occurred while generating billing. Please try again later.',
    errorConnection: '❌ An error occurred while connecting to the payment API.',
    paymentExpired: (planName) => `⚠️ The 30-minute time limit for payment of the **${planName}** plan has expired. If you made the payment, contact support.`,
    channelPrefix: 'purchase-',
    deliveryTitle: '✅ Payment confirmed!',
    deliveryDesc: (discordId) => `Here is your key for Guto Pingo, <@${discordId}>!`,
    fieldKey: '🔑 Your Key',
    fieldPlan: '📦 Plan',
    fieldValidity: '⏰ Validity',
    validityText: {
      '1day': '1 Day',
      '1week': '1 Week',
      '30days': '30 Days',
      'lifetime': 'Lifetime (no expiration)'
    },
    footerClose: 'This channel will be closed in 4 hours.',
    btnClose: 'Close Channel',
    dmTitle: '✅ Payment confirmed - Guto Pingo!',
    dmDesc: (planName) => `Thank you for your purchase! Here is your key for the **${planName}** plan:`,
    closeWarning: '🔒 This purchase channel will be closed and deleted in 5 seconds...'
  },
  pt: {
    choosePlan: '🛒 **Escolha seu Plano**',
    plan1Day: '1 Dia - R$ 20',
    plan1Week: '1 Semana - R$ 45',
    plan30Days: '30 Dias - R$ 100',
    planLifetime: 'Vitalício - R$ 169,99',
    paymentMethod: 'Como você deseja realizar o pagamento?',
    pixLabel: 'PIX',
    cardLabel: 'Cartão de Crédito',
    waitPayment: 'Aguardando confirmação do pagamento...',
    paymentInstructions: '⚠️ **Após o pagamento, sua key será entregue automaticamente em um canal privado neste servidor. Não feche o Discord!**',
    btnPayLabel: 'Ir para o Pagamento',
    errorBilling: '❌ Ocorreu um erro ao gerar a cobrança. Por favor, tente novamente mais tarde.',
    errorConnection: '❌ Ocorreu um erro ao se conectar com a API de pagamento.',
    paymentExpired: (planName) => `⚠️ O tempo limite de 30 minutos para o pagamento do plano **${planName}** expirou. Se você já realizou o pagamento, fale com o suporte.`,
    channelPrefix: 'compra-',
    deliveryTitle: '✅ Pagamento confirmado!',
    deliveryDesc: (discordId) => `Aqui está sua key do Guto Pingo, <@${discordId}>!`,
    fieldKey: '🔑 Sua Chave',
    fieldPlan: '📦 Plano',
    fieldValidity: '⏰ Validade',
    validityText: {
      '1day': '1 Dia',
      '1week': '1 Semana',
      '30days': '30 Dias',
      'lifetime': 'Vitalício (sem expiração)'
    },
    footerClose: 'Este canal será fechado em 4 horas.',
    btnClose: 'Fechar Canal',
    dmTitle: '✅ Pagamento confirmado - Guto Pingo!',
    dmDesc: (planName) => `Obrigado pela compra! Aqui está sua key do plano **${planName}**:`,
    closeWarning: '🔒 Este canal de compra será fechado e excluído em 5 segundos...'
  },
  tr: {
    choosePlan: '🛒 **Planınızı Seçin**',
    plan1Day: '1 Günlük - R$ 20',
    plan1Week: '1 Haftalık - R$ 45',
    plan30Days: '30 Günlük - R$ 100',
    planLifetime: 'Ömür Boyu - R$ 169,99',
    paymentMethod: 'Nasıl ödeme yapmak istersiniz?',
    pixLabel: 'PIX (Brezilya)',
    cardLabel: 'Kredi Kartı',
    waitPayment: 'Ödeme onayı bekleniyor...',
    paymentInstructions: '⚠️ **Ödemeden sonra anahtarınız bu sunucudaki özel bir kanalda otomatik olarak teslim edilecektir. Discord\'u kapatmayın!**',
    btnPayLabel: 'Ödemeye Git',
    errorBilling: '❌ Fatura oluşturulurken bir hata oluştu. Lütfen daha sonra tekrar deneyin.',
    errorConnection: '❌ Ödeme API\'sine bağlanırken bir hata oluştu.',
    paymentExpired: (planName) => `⚠️ **${planName}** planı için 30 dakikalık ödeme süresi doldu. Ödeme yaptıysanız destek ekibiyle iletişime geçin.`,
    channelPrefix: 'satinalma-',
    deliveryTitle: '✅ Ödeme onaylandı!',
    deliveryDesc: (discordId) => `İşte Guto Pingo anahtarınız, <@${discordId}>!`,
    fieldKey: '🔑 Anahtarınız',
    fieldPlan: '📦 Plan',
    fieldValidity: '⏰ Geçerlilik',
    validityText: {
      '1day': '1 Gün',
      '1week': '1 Hafta',
      '30days': '30 Gün',
      'lifetime': 'Ömür Boyu (süre sınırı yok)'
    },
    footerClose: 'Bu kanal 4 saat içinde kapatılacaktır.',
    btnClose: 'Kanalı Kapat',
    dmTitle: '✅ Ödeme onaylandı - Guto Pingo!',
    dmDesc: (planName) => `Satın aldığınız için teşekkürler! İşte **${planName}** planı anahtarınız:`,
    closeWarning: '🔒 Bu satın alma kanalı 5 saniye içinde kapatılacak ve silinecektir...'
  }
};

client.on('interactionCreate', async (interaction) => {
  // 1. Tratamento do Comando de Setup (/setup-support)
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-support') {
      // Verificar permissão de Administrador
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: 'Only administrators can use this command.',
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const channelId = SUPPORT_CHANNEL_ID || interaction.channelId;
      const targetChannel = interaction.guild.channels.cache.get(channelId);

      if (!targetChannel || !targetChannel.isTextBased()) {
        return interaction.editReply({
          content: `Invalid or not found support channel. Please check the ID in the .env file.`
        });
      }

      const supportEmbed = new EmbedBuilder()
        .setTitle('🔑 Guto - Trial Key Claim / Resgate de Chave / Deneme Anahtarı')
        .setDescription(
          '🇧🇷 **Português:**\n' +
          'Selecione seu idioma abaixo para resgatar sua chave de teste de 5 minutos.\n\n' +
          '──────────────────────────\n\n' +
          '🇺🇸 **English:**\n' +
          'Select your language below to claim your free 5-minute trial key.\n\n' +
          '──────────────────────────\n\n' +
          '🇹🇷 **Türkçe:**\n' +
          '5 dakikalık ücretsiz deneme anahtarınızı almak için aşağıdan dilinizi seçin.'
        )
        .setColor(0x5865F2)
        .setFooter({ text: 'Guto Key System • Powered by Discord.js & Supabase' })
        .setTimestamp();

      const btnEn = new ButtonBuilder()
        .setCustomId('claim_trial_key_en')
        .setLabel('English')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🇺🇸');

      const btnPt = new ButtonBuilder()
        .setCustomId('claim_trial_key_pt')
        .setLabel('Português')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🇧🇷');

      const btnTr = new ButtonBuilder()
        .setCustomId('claim_trial_key_tr')
        .setLabel('Türkçe')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🇹🇷');

      const row = new ActionRowBuilder().addComponents(btnEn, btnPt, btnTr);

      try {
        await targetChannel.send({
          content: '@everyone',
          embeds: [supportEmbed],
          components: [row]
        });
        await interaction.editReply({
          content: `Support panel sent successfully in the channel: ${targetChannel}`
        });
      } catch (err) {
        console.error('[Bot] Erro ao enviar o painel no canal:', err);
        await interaction.editReply({
          content: `Error sending message to the channel. Make sure the bot has the required permissions.`
        });
      }
    } else if (interaction.commandName === 'setup-shop') {
      // Verificar permissão de Administrador
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: 'Somente administradores podem usar este comando.',
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const channelId = SHOP_CHANNEL_ID || interaction.channelId;
      const targetChannel = interaction.guild.channels.cache.get(channelId);

      if (!targetChannel || !targetChannel.isTextBased()) {
        return interaction.editReply({
          content: `Canal de vendas inválido ou não encontrado. Verifique o SHOP_CHANNEL_ID no seu arquivo .env.`
        });
      }

      const shopEmbed = new EmbedBuilder()
        .setTitle('🛒 GUTO PINGO - Comprar Key')
        .setDescription(
          'Selecione um plano abaixo para adquirir sua chave de acesso ao **Guto Pingo**.\n\n' +
          'Após o pagamento, um canal privado será criado automaticamente para entregar sua chave de licença.'
        )
        .setColor(0x00FF87) // Premium vibrant green
        .setFooter({ text: 'Sistema de Vendas Guto Pingo • Pagamento seguro' })
        .setTimestamp();

      const btn1Day = new ButtonBuilder()
        .setCustomId('buy_plan_1day')
        .setLabel('1 Dia - R$ 20')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🌅');

      const btn1Week = new ButtonBuilder()
        .setCustomId('buy_plan_1week')
        .setLabel('1 Semana - R$ 45')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📅');

      const btn30Days = new ButtonBuilder()
        .setCustomId('buy_plan_30days')
        .setLabel('30 Dias - R$ 100')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🗓️');

      const btnLifetime = new ButtonBuilder()
        .setCustomId('buy_plan_lifetime')
        .setLabel('Vitalício - R$ 169,99')
        .setStyle(ButtonStyle.Success)
        .setEmoji('👑');

      const row = new ActionRowBuilder().addComponents(btn1Day, btn1Week, btn30Days, btnLifetime);

      try {
        await targetChannel.send({
          embeds: [shopEmbed],
          components: [row]
        });
        await interaction.editReply({
          content: `Painel de vendas enviado com sucesso no canal: ${targetChannel}`
        });
      } catch (err) {
        console.error('[Shop] Erro ao enviar o painel no canal:', err);
        await interaction.editReply({
          content: `Erro ao enviar mensagem ao canal. Certifique-se de que o bot possui as permissões necessárias.`
        });
      }
    }
  }

  // 2. Tratamento do Clique no Botão de Resgate de Key (para as 3 linguagens)
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('claim_trial_key_')) {
      await interaction.deferReply({ ephemeral: true });

      const lang = interaction.customId.split('_').pop(); // 'en', 'pt', or 'tr'
      const texts = LOCALE[lang] || LOCALE.en;
      const discordId = interaction.user.id;
      const guild = interaction.guild;

      // Atribuir o cargo de idioma correspondente
      const roleNameMap = {
        en: 'English',
        pt: 'Português',
        tr: 'Türkçe'
      };
      const targetRoleName = roleNameMap[lang];
      if (guild && targetRoleName) {
        const roleToGive = guild.roles.cache.find(r => r.name === targetRoleName);
        if (roleToGive) {
          const member = await guild.members.fetch(discordId).catch(() => null);
          if (member && !member.roles.cache.has(roleToGive.id)) {
            await member.roles.add(roleToGive).catch((err) => {
              console.error(`[Roles] Erro ao atribuir cargo ${targetRoleName} para ${member.user.tag}:`, err);
            });
          }
        }
      }

      try {
        // Verificar se o usuário já resgatou uma key na tabela de controle separada (discord_claims)
        const { data: claimData, error: claimFetchError } = await supabase
          .from(CLAIMS_TABLE)
          .select('*')
          .eq('discord_id', discordId);

        if (claimFetchError) {
          console.error('[Supabase] Erro ao buscar controle de resgates:', claimFetchError);
          return interaction.editReply({
            content: texts.claimsError
          });
        }

        // Se houver algum registro para este Discord ID, impede o resgate
        if (claimData && claimData.length > 0) {
          return interaction.editReply({
            content: texts.alreadyClaimed
          });
        }

        // Gerar nova chave
        const newKey = generateTrialKey();

        // 1. Salvar a nova chave na tabela de LICENÇAS principal
        const insertKeyData = {
          [COL_KEY]: newKey,
          status: 'active',
          max_devices: 1
        };

        const { error: keyInsertError } = await supabase
          .from(SUPABASE_TABLE)
          .insert([insertKeyData]);

        if (keyInsertError) {
          console.error('[Supabase] Erro ao inserir na tabela de licenças:', keyInsertError);
          return interaction.editReply({
            content: texts.insertError
          });
        }

        // 2. Registrar o resgate na tabela de CONTROLE (discord_claims) para evitar novos resgates
        const { error: claimInsertError } = await supabase
          .from(CLAIMS_TABLE)
          .insert([
            {
              discord_id: discordId,
              key: newKey
            }
          ]);

        if (claimInsertError) {
          console.error('[Supabase] Erro ao registrar controle de resgate:', claimInsertError);
        }

        // Criar um canal de texto privado para enviar a chave ao usuário
        const guild = interaction.guild;
        const channelName = `trial-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

        const privateChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: guild.id, // @everyone (Bloqueia visualização geral)
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: discordId, // Usuário que solicitou (Permite visualização e leitura)
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
              ],
            },
            {
              id: client.user.id, // O próprio Bot
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels
              ],
            }
          ]
        });

        // Enviar Embed no canal recém-criado com a key
        const keyEmbed = new EmbedBuilder()
          .setTitle(texts.embedTitle)
          .setDescription(texts.embedDesc(interaction.user))
          .setColor(0x00FF87) // HSL tailored vibrant green
          .addFields(
            { name: texts.fieldKey, value: `\`\`\`${newKey}\`\`\`` },
            { name: texts.fieldDuration, value: texts.fieldDurationVal, inline: true },
            { name: texts.fieldStatus, value: texts.fieldStatusVal, inline: true }
          )
          .setFooter({ text: texts.embedFooter })
          .setTimestamp();

        const closeButton = new ButtonBuilder()
          .setCustomId(`close_support_channel_${lang}`)
          .setLabel(texts.closeLabel)
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒');

        const row = new ActionRowBuilder().addComponents(closeButton);

        await privateChannel.send({
          content: `${interaction.user}`,
          embeds: [keyEmbed],
          components: [row]
        });

        // Responder à interação original com link para o canal privado
        await interaction.editReply({
          content: texts.successReply(privateChannel)
        });

        // Excluir o canal automaticamente em 4 horas (14.400.000 ms) como temporizador local
        setTimeout(async () => {
          try {
            const currentChannel = guild.channels.cache.get(privateChannel.id);
            if (currentChannel) {
              await currentChannel.delete('Limite de 4 horas do canal de teste atingido.');
              console.log(`[Bot] Canal ${privateChannel.name} deletado automaticamente após 4 horas.`);
            }
          } catch (err) {
            // Silencia o erro se o canal já foi excluído manualmente pelo usuário
          }
        }, 4 * 60 * 60 * 1000);

      } catch (err) {
        console.error('[Bot] Erro ao criar canal ou processar requisição:', err);
        await interaction.editReply({
          content: texts.channelError
        });
      }
    }

    // 3. Tratamento de Clique no Botão de Fechar Canal Privado
    if (interaction.customId.startsWith('close_support_channel_')) {
      const lang = interaction.customId.split('_').pop();
      const texts = LOCALE[lang] || LOCALE.en;

      try {
        await interaction.reply({
          content: texts.closeWarning
        });

        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (deleteError) {
            console.error('[Bot] Não foi possível deletar o canal:', deleteError);
          }
        }, 5000);

      } catch (err) {
        console.error('[Bot] Erro ao responder fechamento de canal:', err);
      }
    }

    // 4. Tratamento de Clique no Botão de Seleção de Idioma para Compra
    if (interaction.customId.startsWith('buy_lang_')) {
      const lang = interaction.customId.replace('buy_lang_', ''); // 'en', 'pt', or 'tr'
      const texts = SHOP_LOCALE[lang] || SHOP_LOCALE.pt;

      const btn1Day = new ButtonBuilder()
        .setCustomId(`buy_plan_1day_${lang}`)
        .setLabel(texts.plan1Day)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🌅');

      const btn1Week = new ButtonBuilder()
        .setCustomId(`buy_plan_1week_${lang}`)
        .setLabel(texts.plan1Week)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📅');

      const btn30Days = new ButtonBuilder()
        .setCustomId(`buy_plan_30days_${lang}`)
        .setLabel(texts.plan30Days)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🗓️');

      const btnLifetime = new ButtonBuilder()
        .setCustomId(`buy_plan_lifetime_${lang}`)
        .setLabel(texts.planLifetime)
        .setStyle(ButtonStyle.Success)
        .setEmoji('👑');

      const row = new ActionRowBuilder().addComponents(btn1Day, btn1Week, btn30Days, btnLifetime);

      try {
        await interaction.reply({
          content: texts.choosePlan,
          components: [row],
          ephemeral: true
        });
      } catch (err) {
        console.error('[Shop] Erro ao responder seleção de idioma:', err);
      }
    }

    // 5. Tratamento de Clique no Botão de Compra de Planos (Multilíngue)
    if (interaction.customId.startsWith('buy_plan_')) {
      const parts = interaction.customId.split('_');
      const planId = parts[2]; // '1day', '1week', '30days', 'lifetime'
      const lang = parts[3] || 'pt'; // 'en', 'pt', 'tr'
      const texts = SHOP_LOCALE[lang] || SHOP_LOCALE.pt;

      const planNameMap = {
        '1day': texts.plan1Day.split(' - ')[0],
        '1week': texts.plan1Week.split(' - ')[0],
        '30days': texts.plan30Days.split(' - ')[0],
        'lifetime': texts.planLifetime.split(' - ')[0]
      };
      const planName = planNameMap[planId] || planId;

      const btnPix = new ButtonBuilder()
        .setCustomId(`pay_method_pix_${planId}_${lang}`)
        .setLabel(texts.pixLabel)
        .setStyle(ButtonStyle.Success)
        .setEmoji('🇧🇷');

      const btnStripe = new ButtonBuilder()
        .setCustomId(`pay_method_stripe_${planId}_${lang}`)
        .setLabel(texts.cardLabel)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('💳');

      const row = new ActionRowBuilder().addComponents(btnPix, btnStripe);

      try {
        await interaction.reply({
          content: `${texts.paymentMethod}\n*(Plan: **${planName}**)*`,
          components: [row],
          ephemeral: true
        });
      } catch (err) {
        console.error('[Shop] Erro ao responder seleção de plano:', err);
      }
    }

    // 6. Tratamento de Clique no Método de Pagamento (Multilíngue)
    if (interaction.customId.startsWith('pay_method_')) {
      const parts = interaction.customId.split('_');
      const method = parts[2]; // 'pix' or 'stripe'
      const planId = parts[3]; // '1day', '1week', '30days', 'lifetime'
      const lang = parts[4] || 'pt'; // 'en', 'pt', 'tr'
      const texts = SHOP_LOCALE[lang] || SHOP_LOCALE.pt;

      try {
        await interaction.deferReply({ ephemeral: true });

        const discordId = interaction.user.id;
        const username = interaction.user.username;

        console.log(`[Shop] Criando ordem para ${username} (${discordId}) - Plano: ${planId}, Método: ${method}, Idioma: ${lang}`);

        const PLAN_PRICES = {
          '1day': 2000,
          '1week': 4500,
          '30days': 10000,
          'lifetime': 16999
        };
        const amountCents = PLAN_PRICES[planId];
        if (!amountCents) {
          return interaction.editReply({
            content: texts.errorBilling
          });
        }

        const planNameMap = {
          '1day': texts.plan1Day.split(' - ')[0],
          '1week': texts.plan1Week.split(' - ')[0],
          '30days': texts.plan30Days.split(' - ')[0],
          'lifetime': texts.planLifetime.split(' - ')[0]
        };
        const planName = planNameMap[planId] || planId;

        let paymentUrl;
        let paymentReference;

        if (method === 'pix') {
          console.log(`[Shop] Gerando pagamento PIX (LivePix) de ${amountCents} centavos...`);
          const paymentData = await createLivePixPayment(amountCents);
          paymentUrl = paymentData.redirectUrl;
          paymentReference = paymentData.reference;
        } else {
          console.log(`[Shop] Gerando sessão Stripe de ${amountCents} centavos para ${planName}...`);
          const session = await createStripeSession(amountCents, planName, planId, discordId);
          paymentUrl = session.url;
          paymentReference = session.id;
        }

        const { data: orderData, error: dbError } = await supabase
          .from('bot_orders')
          .insert([
            {
              discord_id: discordId,
              discord_username: username,
              plan_id: planId,
              method: method,
              amount_cents: amountCents,
              status: 'pending',
              payment_reference: paymentReference,
              payment_url: paymentUrl
            }
          ])
          .select()
          .single();

        if (dbError) {
          console.error('[Shop] Erro ao salvar ordem no Supabase:', dbError);
          return interaction.editReply({
            content: texts.errorBilling
          });
        }

        const orderId = orderData.id;
        activeOrdersLang.set(orderId, lang);

        const paymentEmbed = new EmbedBuilder()
          .setTitle(`💳 ${texts.paymentMethod}`)
          .setDescription(
            `**${planName}**\n\n` +
            `**Valor:** R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}\n` +
            `**Método:** ${method === 'pix' ? texts.pixLabel : texts.cardLabel}\n\n` +
            `Clique no botão abaixo para ir à página de pagamento.`
          )
          .setColor(0xF1C40F)
          .setFooter({ text: texts.waitPayment })
          .setTimestamp();

        const btnPay = new ButtonBuilder()
          .setLabel(texts.btnPayLabel)
          .setURL(paymentUrl)
          .setStyle(ButtonStyle.Link);

        const payRow = new ActionRowBuilder().addComponents(btnPay);

        await interaction.editReply({
          content: texts.paymentInstructions,
          embeds: [paymentEmbed],
          components: [payRow]
        });

        // Configurar inscrição no Supabase Realtime para esta ordem
        console.log(`[Realtime] Inscrevendo no canal bot_order_${orderId} para o usuário ${username}`);
        
        let timeout;

        const channel = supabase
          .channel(`bot_order_${orderId}`)
          .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'bot_orders', filter: `id=eq.${orderId}` },
            async (payload) => {
              console.log(`[Realtime] Update detectado na ordem ${orderId}. Status: ${payload.new.status}`);
              if (payload.new.status === 'paid' && payload.new.license_key) {
                clearTimeout(timeout);
                channel.unsubscribe();
                console.log(`[Realtime] Ordem ${orderId} foi paga. Iniciando entrega.`);
                await deliverKey(payload.new, lang);
              }
            })
          .subscribe((status) => {
            console.log(`[Realtime] Subscription status para canal bot_order_${orderId}: ${status}`);
          });

        timeout = setTimeout(async () => {
          channel.unsubscribe();
          console.log(`[Realtime] Inscrição da ordem ${orderId} expirou por timeout (30 minutos).`);
          try {
            const user = await client.users.fetch(discordId);
            if (user) {
              await user.send(texts.paymentExpired(planName));
            }
          } catch (dmError) {
            console.warn(`[Shop] Não foi possível enviar DM de expiração para ${username}:`, dmError.message);
          }
        }, 30 * 60 * 1000);

      } catch (err) {
        console.error('[Shop] Erro de conexão/API ao processar pagamento:', err);
        return interaction.editReply({
          content: texts.errorConnection
        });
      }
    }

    // 7. Tratamento de Clique no Botão de Fechar Canal de Compra (Multilíngue)
    if (interaction.customId.startsWith('close_purchase_channel_')) {
      const lang = interaction.customId.split('_').pop();
      const texts = SHOP_LOCALE[lang] || SHOP_LOCALE.pt;
      try {
        await interaction.reply({
          content: texts.closeWarning
        });

        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (deleteError) {
            console.error('[Bot] Não foi possível deletar o canal de compra:', deleteError);
          }
        }, 5000);

      } catch (err) {
        console.error('[Bot] Erro ao responder fechamento de canal de compra:', err);
      }
    }
  }
});

// Efetua o login do Bot do Discord
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[Bot] Falha crítica ao fazer login no Discord. Verifique seu token no arquivo .env:', err);
});
