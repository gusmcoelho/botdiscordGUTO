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
          // Se já houver um agendamento pendente, ignora este para evitar acúmulo
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

    // 1. Verificar/Criar cargo "Membros" (Roxo)
    let roleMembros = guild.roles.cache.find(r => r.name === 'Membros');
    if (!roleMembros) {
      roleMembros = await guild.roles.create({
        name: 'Membros',
        color: '#9B59B6', // Roxo
        reason: 'Cargo inicial criado pelo bot'
      });
      console.log('[Roles] Cargo "Membros" criado.');
    }

    // 2. Verificar/Criar cargo "Penguin Supremo" (Amarelo)
    let rolePenguin = guild.roles.cache.find(r => r.name === 'Penguin Supremo');
    if (!rolePenguin) {
      rolePenguin = await guild.roles.create({
        name: 'Penguin Supremo',
        color: '#F1C40F', // Amarelo
        reason: 'Cargo especial criado pelo bot'
      });
      console.log('[Roles] Cargo "Penguin Supremo" criado.');
    }

    // 3. Atribuir cargo "Membros" para todos que já estão no servidor e ainda não possuem
    console.log('[Roles] Verificando membros existentes para atribuição de tag...');
    const members = await guild.members.fetch();
    let count = 0;

    for (const [id, member] of members) {
      if (!member.user.bot && !member.roles.cache.has(roleMembros.id)) {
        await member.roles.add(roleMembros).catch((err) => {
          console.error(`[Roles] Não foi possível dar o cargo a ${member.user.tag}:`, err);
        });
        count++;
      }
    }

    if (count > 0) {
      console.log(`[Roles] Cargo "Membros" atribuído a ${count} membros existentes.`);
    } else {
      console.log('[Roles] Todos os membros atuais já possuem a tag "Membros".');
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

    // 1. Dar cargo de Membro
    const roleMembros = guild.roles.cache.find(r => r.name === 'Membros');
    if (roleMembros) {
      await member.roles.add(roleMembros);
      console.log(`[Roles] Novo membro ${member.user.tag} recebeu o cargo "Membros".`);
    }

    // 2. Atualizar o contador de membros
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
client.on('interactionCreate', async (interaction) => {
  // 1. Tratamento do Comando de Setup (/setup-support)
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-support') {
      // Verificar permissão de Administrador
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: 'Apenas administradores podem utilizar este comando.',
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const channelId = SUPPORT_CHANNEL_ID || interaction.channelId;
      const targetChannel = interaction.guild.channels.cache.get(channelId);

      if (!targetChannel || !targetChannel.isTextBased()) {
        return interaction.editReply({
          content: `Canal de suporte inválido ou não encontrado. Verifique o ID no arquivo .env.`
        });
      }

      const supportEmbed = new EmbedBuilder()
        .setTitle('🔑 Guto - Resgate de Chave de Teste')
        .setDescription(
          'Olá! Você pode solicitar uma chave de teste grátis de **5 minutos** para experimentar o nosso produto.\n\n' +
          '**Regras & Informações:**\n' +
          '• Limite de no máximo **1 chave por pessoa**.\n' +
          '• A chave expira automaticamente 5 minutos após o resgate.\n' +
          '• O bot criará um canal de texto privado para você receber sua chave.'
        )
        .setColor(0x5865F2)
        .setFooter({ text: 'Sistema de Chaves Guto • Desenvolvido com Discord.js & Supabase' })
        .setTimestamp();

      const claimButton = new ButtonBuilder()
        .setCustomId('claim_trial_key')
        .setLabel('Pegar Key de 5 Minutos')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔑');

      const row = new ActionRowBuilder().addComponents(claimButton);

      try {
        await targetChannel.send({
          embeds: [supportEmbed],
          components: [row]
        });
        await interaction.editReply({
          content: `Painel de suporte enviado com sucesso no canal: ${targetChannel}`
        });
      } catch (err) {
        console.error('[Bot] Erro ao enviar o painel no canal:', err);
        await interaction.editReply({
          content: `Erro ao enviar mensagem no canal. Verifique se o bot possui as permissões necessárias.`
        });
      }
    }
  }

  // 2. Tratamento do Clique no Botão de Resgate de Key
  if (interaction.isButton()) {
    if (interaction.customId === 'claim_trial_key') {
      await interaction.deferReply({ ephemeral: true });

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
            content: '❌ Ocorreu um erro ao consultar o controle de resgates. Por favor, certifique-se de que criou a tabela `discord_claims` no seu Supabase.'
          });
        }

        // Se houver algum registro para este Discord ID, impede o resgate
        if (claimData && claimData.length > 0) {
          return interaction.editReply({
            content: '⚠️ Você já resgatou a sua chave de teste anteriormente! O limite é de apenas **1 chave por pessoa**.'
          });
        }

        // Gerar nova chave e data de expiração (5 minutos a partir de agora)
        const newKey = generateTrialKey();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // 1. Salvar a nova chave na tabela de LICENÇAS principal
        const insertKeyData = {
          [COL_KEY]: newKey,
          status: 'active',
          max_devices: 1,
          [COL_EXPIRATION]: expiresAt.toISOString()
        };

        const { error: keyInsertError } = await supabase
          .from(SUPABASE_TABLE)
          .insert([insertKeyData]);

        if (keyInsertError) {
          console.error('[Supabase] Erro ao inserir na tabela de licenças:', keyInsertError);
          return interaction.editReply({
            content: '❌ Não foi possível registrar sua chave na tabela de licenças. Verifique o mapeamento das colunas no arquivo .env.'
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

        // Enviar Embed no canal recém-criado com a key de 5 minutos
        const keyEmbed = new EmbedBuilder()
          .setTitle('🔑 Sua Key de Teste do Guto!')
          .setDescription(`Olá ${interaction.user}, aqui está sua chave de acesso temporária para testar o **Guto**!`)
          .setColor(0x00FF87) // HSL tailored vibrant green
          .addFields(
            { name: 'Sua Chave', value: `\`\`\`${newKey}\`\`\`` },
            { name: 'Duração', value: '5 Minutos', inline: true },
            { name: 'Expiração', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true }
          )
          .setFooter({ text: 'Esta chave é de uso exclusivo e expira em 5 minutos. Este canal fechará automaticamente em 4 horas.' })
          .setTimestamp();

        const closeButton = new ButtonBuilder()
          .setCustomId('close_support_channel')
          .setLabel('Fechar Canal')
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
          content: `✅ Sua chave de teste foi gerada com sucesso! Entre no seu canal privado para visualizá-la: ${privateChannel}`
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
          content: '❌ Ocorreu um erro ao criar seu canal privado. Certifique-se de que o bot possui a permissão de **Gerenciar Canais**.'
        });
      }
    }

    // 3. Tratamento de Clique no Botão de Fechar Canal Privado
    if (interaction.customId === 'close_support_channel') {
      try {
        await interaction.reply({
          content: '🔒 Este canal de suporte será fechado e excluído em 5 segundos...'
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
