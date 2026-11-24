require("dotenv").config();

const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} = require("discord.js");

const {
  BOT_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  MIX_RUNNER_ROLE_ID,
  LOBBY_VOICE_CHANNEL_ID,
  RED_VOICE_CHANNEL_ID,
  BLU_VOICE_CHANNEL_ID,
} = process.env;

if (
  !BOT_TOKEN ||
  !CLIENT_ID ||
  !GUILD_ID ||
  !MIX_RUNNER_ROLE_ID ||
  !LOBBY_VOICE_CHANNEL_ID ||
  !RED_VOICE_CHANNEL_ID ||
  !BLU_VOICE_CHANNEL_ID
) {
  throw new Error(
    "BOT_TOKEN, CLIENT_ID, GUILD_ID, MIX_RUNNER_ROLE_ID, LOBBY_VOICE_CHANNEL_ID, RED_VOICE_CHANNEL_ID, and BLU_VOICE_CHANNEL_ID must be set in the .env file.",
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

async function generateTeams(guild, size) {
  const lobbyChannel = await guild.channels.fetch(LOBBY_VOICE_CHANNEL_ID);
  const redChannel = await guild.channels.fetch(RED_VOICE_CHANNEL_ID);
  const bluChannel = await guild.channels.fetch(BLU_VOICE_CHANNEL_ID);

  if (
    !lobbyChannel?.isVoiceBased() ||
    !redChannel?.isVoiceBased() ||
    !bluChannel?.isVoiceBased() ||
    lobbyChannel.guildId !== GUILD_ID ||
    redChannel.guildId !== GUILD_ID ||
    bluChannel.guildId !== GUILD_ID ||
    new Set([
      LOBBY_VOICE_CHANNEL_ID,
      RED_VOICE_CHANNEL_ID,
      BLU_VOICE_CHANNEL_ID,
    ]).size !== 3
  ) {
    throw new Error(
      "Configured Lobby, RED, and BLU channels must be distinct voice channels in the configured server.",
    );
  }

  const candidates = [...lobbyChannel.members.values()].filter(
    (member) => !member.user.bot,
  );

  const requiredCount = size * 2;
  if (requiredCount > candidates.length) {
    return {
      insufficient: `There are only ${candidates.length} in Lobby; ${requiredCount} are needed (${size} per team).`,
    };
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const selected = candidates.slice(0, requiredCount);
  const redTeam = selected.slice(0, size);
  const bluTeam = selected.slice(size);
  const stillInLobby = selected.filter(
    (member) => member.voice.channelId === LOBBY_VOICE_CHANNEL_ID,
  );
  const moveResults = await Promise.allSettled(
    stillInLobby.map((member) =>
      member.voice.setChannel(
        redTeam.includes(member) ? redChannel : bluChannel,
      ),
    ),
  );
  const movedCount = moveResults.filter(
    (result) => result.status === "fulfilled",
  ).length;

  const makeTeamFields = (team, name) => {
    const chunks = [];
    for (let i = 0; i < team.length; i += 40) {
      chunks.push(team.slice(i, i + 40));
    }

    return chunks.map((chunk, index) => ({
      name: chunks.length > 1 ? `${name} (${index + 1}/${chunks.length})` : name,
      value: chunk.map((member) => `<@${member.id}>`).join("\n"),
      inline: true,
    }));
  };

  return {
    embed: new EmbedBuilder()
      .setTitle(`Teams (${size} players each)`)
      .addFields(
        ...makeTeamFields(redTeam, `RED (${redTeam.length})`),
        ...makeTeamFields(bluTeam, `BLU (${bluTeam.length})`),
      )
      .setFooter({
        text: `${movedCount} member(s) moved; ${selected.length - stillInLobby.length} left Lobby before moving.`,
      }),
    failedMoves: moveResults.length - movedCount,
  };
}

async function memberCanRunTeam(guild, userId) {
  const member = await guild.members.fetch(userId);
  return member.roles.cache.has(MIX_RUNNER_ROLE_ID);
}

async function sendTeamResult(size, guild, send, sendNotice = send) {
  const result = await generateTeams(guild, size);
  if (result.insufficient) {
    await send({ content: result.insufficient });
    return;
  }

  await send({
    embeds: [result.embed],
    allowedMentions: { parse: [] },
  });

  if (result.failedMoves > 0) {
    console.error(
      `Could not move ${result.failedMoves} selected member(s) in guild ${GUILD_ID}. Check the bot's Move Members permission.`,
    );
    await sendNotice({
      content: `I couldn't move ${result.failedMoves} member(s). Check that I have the Move Members permission.`,
    });
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  try {
    console.log(
      `Logged in as ${readyClient.user.tag}; !team is enabled in guild ${GUILD_ID}.`,
    );
  } catch (error) {
    console.error("Failed to register the !team command:", error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const match = message.content.match(/^!team(?:\s+(\d+))?\s*$/i);
  if (!match) return;

  if (message.guildId !== GUILD_ID) return;

  const size = Number(match[1]);
  if (!Number.isInteger(size)) {
    await message.reply("Usage: `!team <size>`");
    return;
  }

  try {
    if (!(await memberCanRunTeam(message.guild, message.author.id))) {
      return;
    }
  } catch (error) {
    console.error("Failed to check the Mix Runner role:", error);
    await message.reply("I couldn't verify your role. Please try again.");
    return;
  }

  try {
    await sendTeamResult(size, message.guild, (payload) =>
      message.reply(payload),
    );
  } catch (error) {
    console.error("Failed to generate or move the teams:", error);
    await message.reply(
      "I couldn't generate the teams. Check the Server Members Intent, configured voice-channel IDs, and my server permissions.",
    );
  }
});

client.login(BOT_TOKEN);