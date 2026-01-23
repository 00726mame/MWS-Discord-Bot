// Minimal Discord bot to create temporary voice rooms via /room command
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Routes, REST, ChannelType, PermissionsBitField } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ALLOWED_ROLE_ID = '1463855695513522270';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// In-memory map per guild of created rooms and their timers
// guildRooms: Map<guildId, Array<{ channelId, textId, creatorId, timeout, idleTimeout, name }>>
const guildRooms = new Map();

async function registerCommands() {
  const commands = [
    {
      name: 'room',
      description: 'Create a temporary voice room',
      options: [
        { name: 'name', type: 3, description: 'Room name', required: true },
        { name: 'time', type: 4, description: 'Auto-delete after minutes (optional)', required: false },
        { name: 'idle', type: 4, description: 'Auto-delete after X minutes of empty (optional, default 1)', required: false }
      ]
    },
    {
      name: 'purge',
      description: 'Delete the latest N messages in a channel',
      options: [
        { name: 'channel', type: 7, description: 'Target channel', required: true },
        { name: 'count', type: 4, description: 'Number of messages to delete (1-1000)', required: true }
      ]
    },
    {
      name: 'purgeall',
      description: 'Delete as many messages as possible in a channel',
      options: [
        { name: 'channel', type: 7, description: 'Target channel', required: true }
      ]
    }
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering global commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commands registered');
  } catch (err) {
    console.error('Failed to register commands', err);
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

async function getOrCreateLogChannel(guild) {
  const name = 'vc-log';
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
  if (existing) return existing;
  try {
    const created = await guild.channels.create({ name, type: ChannelType.GuildText });
    return created;
  } catch (e) {
    console.error('Failed to create/find log channel', e);
    return null;
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'room') {
    const name = interaction.options.getString('name');
    const time = interaction.options.getInteger('time');
    const idle = interaction.options.getInteger('idle') ?? 1; // minutes
    const guildId = interaction.guildId;
    try {
      const formattedName = `ーー 作業 - ${name} ーー`;

      // check if a category with the same name already exists
      const existingCategory = interaction.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === formattedName);
      if (existingCategory) {
        await interaction.reply({ content: `同名のカテゴリ "${formattedName}" が既に存在します。別名を指定してください。`, ephemeral: true });
        return;
      }

      // create a category and place paired channels inside it
      const category = await interaction.guild.channels.create({
        name: formattedName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: ALLOWED_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel] }
        ]
      });

      const voiceName = `${name}`.slice(0, 100);
      const voice = await interaction.guild.channels.create({
        name: voiceName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
          { id: ALLOWED_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] }
        ]
      });

      // create paired temporary text channel inside the same category
      const textName = `${name}-chat`.slice(0, 100);
      const text = await interaction.guild.channels.create({ name: textName, type: ChannelType.GuildText, parent: category.id });

      // ensure array
      if (!guildRooms.has(guildId)) guildRooms.set(guildId, []);
      const room = { channelId: voice.id, textId: text.id, creatorId: interaction.user.id, name: formattedName };
      guildRooms.get(guildId).push(room);

      // post timer message to paired text channel
      if (time && time > 0) {
        const endAt = new Date(Date.now() + time * 60 * 1000);
        await text.send(`作業開始: ${interaction.user.tag} が作成しました。自動削除予定時刻: ${endAt.toLocaleString()}`);

        const timeout = setTimeout(async () => {
          try {
            const g = interaction.guild;
            const ch = await g.channels.fetch(voice.id).catch(() => null);
            const tc = await g.channels.fetch(text.id).catch(() => null);
            const cat = await g.channels.fetch(category.id).catch(() => null);
            if (tc) await tc.send('自動削除を実行します（時間切れ）');
            if (ch) await ch.delete('Auto-deleted temporary room');
            if (tc) await tc.delete('Auto-deleted paired text channel');
            if (cat) await cat.delete('Auto-deleted category');
            // remove from map
            const arr = guildRooms.get(guildId) || [];
            guildRooms.set(guildId, arr.filter(r => r.channelId !== voice.id));
          } catch (e) {
            console.error('Failed during scheduled deletion', e);
          }
        }, time * 60 * 1000);
        room.timeout = timeout;
      }

      // idle deletion handling: default idle in minutes; schedule when empty later
      room.idleMinutes = idle;

      await interaction.reply({ content: `作成しました: ${voice.name} と ${text.name}`, ephemeral: true });

      // ensure log channel exists and post creation
      const log = await getOrCreateLogChannel(interaction.guild);
      if (log) await log.send(`${interaction.user.tag} が ${voice.name} を作成しました。テキスト: ${text.toString()}`);

    } catch (err) {
      console.error('Failed to create channels', err);
      await interaction.reply({ content: 'チャンネル作成に失敗しました（権限を確認してください）', ephemeral: true });
    }
  }

  if (interaction.commandName === 'purge' || interaction.commandName === 'purgeall') {
    const channel = interaction.options.getChannel('channel');
    const count = interaction.commandName === 'purge' ? interaction.options.getInteger('count') : null;
    const isTextChannel = channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;

    if (!channel || !isTextChannel) {
      await interaction.reply({ content: '対象はテキストチャンネルにしてください。', ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages)) {
      await interaction.reply({ content: 'メッセージ管理権限がありません。', ephemeral: true });
      return;
    }

    const botMember = interaction.guild.members.me;
    const botPerms = channel.permissionsFor(botMember);
    if (!botPerms || !botPerms.has(PermissionsBitField.Flags.ManageMessages)) {
      await interaction.reply({ content: 'Botにメッセージ管理権限がありません。', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'purge' && (!count || count < 1 || count > 1000)) {
      await interaction.reply({ content: '削除数は1〜1000で指定してください。', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      let deletedTotal = 0;
      const maxPerBatch = 100;
      let remaining = interaction.commandName === 'purge' ? count : Number.MAX_SAFE_INTEGER;
      let skippedOld = false;

      while (remaining > 0) {
        const batchSize = Math.min(maxPerBatch, remaining);
        const messages = await channel.messages.fetch({ limit: batchSize });
        if (messages.size === 0) break;
        const deleted = await channel.bulkDelete(messages, true);
        deletedTotal += deleted.size;
        if (deleted.size < messages.size) skippedOld = true;
        if (messages.size < batchSize) break;
        remaining -= batchSize;
        if (interaction.commandName === 'purgeall' && deleted.size === 0) break;
      }

      const suffix = skippedOld ? '（14日以上前のメッセージは削除できません）' : '';
      await interaction.editReply(`削除完了: ${channel} から ${deletedTotal} 件削除しました。${suffix}`);
    } catch (err) {
      console.error('Failed to purge messages', err);
      await interaction.editReply('メッセージ削除に失敗しました（権限/制限を確認してください）。');
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content) return;

  const normalized = message.content.replace(/\s+/g, '').toLowerCase();
  if (!normalized.includes('meshrendererがない')) return;

  const guidance = [
    'Mesh Rendererが見当たらない場合は、対象のGameObjectを選択してInspectorの「Add Component」から「Mesh Renderer」を追加してください。',
    'モデルがSkinned Meshの場合は「Skinned Mesh Renderer」を使います。',
    'Mesh Filterにメッシュが割り当てられているかも確認してください。'
  ].join('\n');

  try {
    await message.reply(guidance);
  } catch (err) {
    console.error('Failed to reply to Mesh Renderer message', err);
  }
});

// Monitor joins/parts to post logs and auto-delete when empty
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const guildId = guild.id;
    const rooms = guildRooms.get(guildId) || [];
    // helper to find room by channel id
    const findRoomBy = (chId) => rooms.find(r => r.channelId === chId);

    // handle leave
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const room = findRoomBy(oldState.channelId);
      if (room) {
        const log = await getOrCreateLogChannel(guild);
        if (log) await log.send(`${oldState.member.user.tag} が ${room.name} から退出しました`);

        // check empty
        const ch = await guild.channels.fetch(room.channelId).catch(() => null);
        const count = ch ? ch.members.filter(m => !m.user.bot).size : 0;
        if (count === 0) {
          // schedule idle deletion
          const ms = (room.idleMinutes ?? 1) * 60 * 1000;
          if (room.idleTimeout) clearTimeout(room.idleTimeout);
          room.idleTimeout = setTimeout(async () => {
            try {
              const v = await guild.channels.fetch(room.channelId).catch(() => null);
              const t = await guild.channels.fetch(room.textId).catch(() => null);
              // find category by name
              const cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === room.name);
              if (t) await t.send('参加者が0になったためチャネルを削除します');
              if (v) await v.delete('Auto-delete empty VC');
              if (t) await t.delete('Auto-delete paired text channel');
              if (cat) await cat.delete('Auto-delete empty category');
              // cleanup
              const arr = guildRooms.get(guildId) || [];
              guildRooms.set(guildId, arr.filter(r => r.channelId !== room.channelId));
              if (log) await log.send(`${room.name} を参加者0のため削除しました`);
            } catch (e) {
              console.error('Failed to delete empty channels', e);
            }
          }, ms);
        }
      }
    }

    // handle join
    if (newState.channelId && oldState.channelId !== newState.channelId) {
      const room = findRoomBy(newState.channelId);
      if (room) {
        const log = await getOrCreateLogChannel(guild);
        if (log) await log.send(`${newState.member.user.tag} が ${room.name} に参加しました`);
        // cancel idle deletion if scheduled
        if (room.idleTimeout) {
          clearTimeout(room.idleTimeout);
          room.idleTimeout = null;
        }
      }
    }
  } catch (e) {
    console.error('voiceStateUpdate handler error', e);
  }
});

client.login(TOKEN);

