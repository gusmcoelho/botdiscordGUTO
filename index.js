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
      if (channel && channel.type === ChannelType.GuildText && channel.name.startsWith('trial-')) {
        const age = now - channel.createdTimestamp;
        if (age >= fourHoursMs) {
          console.log(`[Cleanup] Deletando canal expirado: ${channel.name} (Idade: ${Math.round(age / 1000 / 60)} minutos)`);
          await channel.delete('Canal de teste de 5 minutos expirou (limite de 4 horas atingido).').catch((err) => {
            console.error(`[Cleanup] Erro ao deletar o canal ${channel.name}:`, err);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup] Erro crítico ao limpar canais antigos:', err);
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
          }
        ]);
        console.log(`[Bot] Comando /setup-support registrado com sucesso no servidor: ${guild.name}`);
        
        // Configurar e atribuir cargos
        await setupServerRoles();

        // Configurar / Atualizar o contador de membros no topo
        await updateMemberCounter(guild);

        // Executar uma limpeza inicial de canais órfãos antigos ao ligar o bot
        await cleanupOldTrialChannels();

        // Agendar limpeza para rodar a cada 15 minutos
        setInterval(cleanupOldTrialChannels, 15 * 60 * 1000);
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
          'Select your language below to claim your free 5-minute trial key.\n' +
          'Selecione seu idioma abaixo para resgatar sua chave de teste de 5 minutos.\n' +
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
    }
  }

  // 2. Tratamento do Clique no Botão de Resgate de Key (para as 3 linguagens)
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('claim_trial_key_')) {
      await interaction.deferReply({ ephemeral: true });

      const lang = interaction.customId.split('_').pop(); // 'en', 'pt', or 'tr'
      const texts = LOCALE[lang] || LOCALE.en;
      const discordId = interaction.user.id;

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
  }
});

// Efetua o login do Bot do Discord
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[Bot] Falha crítica ao fazer login no Discord. Verifique seu token no arquivo .env:', err);
});
