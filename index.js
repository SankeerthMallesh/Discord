import 'dotenv/config';
import fs from 'fs';
import crypto from 'crypto';
import express from 'express';
import { Client, GatewayIntentBits as I, ChannelType } from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';

const { DISCORD_TOKEN, ANTHROPIC_API_KEY, DASHBOARD_PASSWORD } = process.env;
if (!DISCORD_TOKEN || !ANTHROPIC_API_KEY || !DASHBOARD_PASSWORD) {
  console.error('Set DISCORD_TOKEN, ANTHROPIC_API_KEY and DASHBOARD_PASSWORD in .env');
  process.exit(1);
}

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const ACTIONS = {
  send_message: 'Send messages', create_channel: 'Create channels', rename_channel: 'Rename channels',
  set_topic: 'Set channel topics', create_role: 'Create roles', give_role: 'Give roles', remove_role: 'Remove roles',
  purge_messages: 'Delete recent messages', timeout_member: 'Time out members', delete_channel: 'Delete channels',
  kick_member: 'Kick members', ban_member: 'Ban members',
};
const RISKY = ['purge_messages', 'timeout_member', 'delete_channel', 'kick_member', 'ban_member'];

const DIR = process.env.DATA_DIR || './data';
const FILE = `${DIR}/settings.json`;
fs.mkdirSync(DIR, { recursive: true });
let store = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const defaults = () => ({
  enabled: true, model: 'claude-sonnet-5-5', channels: [],
  personality: 'You are a helpful, friendly assistant living in a Discord server. Keep replies short and clear.',
  actions: Object.fromEntries(Object.keys(ACTIONS).map(k => [k, !RISKY.includes(k)])),
});
const getSettings = id => (store[id] = { ...defaults(), ...store[id], actions: { ...defaults().actions, ...store[id]?.actions } });
const save = () => fs.writeFileSync(FILE, JSON.stringify(store, null, 1));

const log = [];
const note = (guild, who, text, ok = true) => { log.unshift({ t: Date.now(), guild, who, text: text.slice(0, 200), ok }); log.length = Math.min(log.length, 100); };

// ---- Claude tools -------------------------------------------------------
const S = (props, req = []) => ({
  type: 'object', required: req,
  properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }])),
});
const CH = 'Channel name (omit for the current channel)';
const TOOLS = [
  { name: 'send_message', description: 'Post a message in a channel', input_schema: S({ channel: CH, text: 'Message text' }, ['text']) },
  { name: 'create_channel', description: 'Create a text channel', input_schema: S({ name: 'New channel name', topic: 'Optional topic' }, ['name']) },
  { name: 'rename_channel', description: 'Rename a channel', input_schema: S({ channel: CH, new_name: 'New name' }, ['new_name']) },
  { name: 'set_topic', description: 'Set a channel topic', input_schema: S({ channel: CH, topic: 'Topic text' }, ['topic']) },
  { name: 'create_role', description: 'Create a role', input_schema: S({ name: 'Role name', color: 'Hex color like #5865F2' }, ['name']) },
  { name: 'give_role', description: 'Give a member a role', input_schema: S({ member: 'Member name', role: 'Role name' }, ['member', 'role']) },
  { name: 'remove_role', description: 'Remove a role from a member', input_schema: S({ member: 'Member name', role: 'Role name' }, ['member', 'role']) },
  { name: 'purge_messages', description: 'Delete the most recent messages (max 100, under 14 days old)', input_schema: S({ channel: CH, count: 'How many' }, ['count']) },
  { name: 'timeout_member', description: 'Time out a member', input_schema: S({ member: 'Member name', minutes: 'Minutes', reason: 'Reason' }, ['member', 'minutes']) },
  { name: 'delete_channel', description: 'Delete a channel', input_schema: S({ channel: CH }, ['channel']) },
  { name: 'kick_member', description: 'Kick a member', input_schema: S({ member: 'Member name', reason: 'Reason' }, ['member']) },
  { name: 'ban_member', description: 'Ban a member', input_schema: S({ member: 'Member name', reason: 'Reason' }, ['member']) },
];

const fail = m => { throw new Error(m); };
const chan = (g, n, cur) => !n ? cur : g.channels.cache.find(c => c.name === n.replace(/^#/, '').toLowerCase()) ?? fail(`No channel "${n}"`);
const role = (g, n) => g.roles.cache.find(r => r.name.toLowerCase() === n.toLowerCase()) ?? fail(`No role "${n}"`);
const member = async (g, n) => (await g.members.search({ query: n.replace(/^@/, ''), limit: 1 })).first() ?? fail(`No member "${n}"`);

async function exec(name, a, g, cur) {
  switch (name) {
    case 'send_message': await chan(g, a.channel, cur).send(a.text); break;
    case 'create_channel': await g.channels.create({ name: a.name, type: ChannelType.GuildText, topic: a.topic }); break;
    case 'rename_channel': await chan(g, a.channel, cur).setName(a.new_name); break;
    case 'set_topic': await chan(g, a.channel, cur).setTopic(a.topic); break;
    case 'create_role': await g.roles.create({ name: a.name, color: a.color || undefined }); break;
    case 'give_role': await (await member(g, a.member)).roles.add(role(g, a.role)); break;
    case 'remove_role': await (await member(g, a.member)).roles.remove(role(g, a.role)); break;
    case 'purge_messages': await chan(g, a.channel, cur).bulkDelete(Math.min(+a.count || 10, 100), true); break;
    case 'timeout_member': await (await member(g, a.member)).timeout(Math.min(+a.minutes || 10, 40320) * 60000, a.reason); break;
    case 'delete_channel': await chan(g, a.channel, cur).delete(); break;
    case 'kick_member': await (await member(g, a.member)).kick(a.reason); break;
    case 'ban_member': await (await member(g, a.member)).ban({ reason: a.reason }); break;
    default: fail('Unknown action');
  }
  return 'Done';
}

// ---- Agent loop ---------------------------------------------------------
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function runAgent({ guild, channel, text, history = [], canAct, who }) {
  const s = getSettings(guild.id);
  const tools = canAct ? TOOLS.filter(t => s.actions[t.name]) : [];
  const system = `${s.personality}\nServer: ${guild.name}. Current channel: #${channel.name}. ` +
    (tools.length ? 'You may use tools to manage the server when asked. Never act unless asked.' : 'You cannot perform server actions in this conversation.');
  const messages = [...history, { role: 'user', content: text }];
  for (let i = 0; i < 6; i++) {
    const res = await anthropic.messages.create({ model: s.model, max_tokens: 1024, system, messages, ...(tools.length && { tools }) });
    const uses = res.content.filter(b => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Done.';
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      try { results.push({ type: 'tool_result', tool_use_id: u.id, content: await exec(u.name, u.input, guild, channel) }); note(guild.name, who, `${u.name} ${JSON.stringify(u.input)}`); }
      catch (e) { results.push({ type: 'tool_result', tool_use_id: u.id, content: e.message, is_error: true }); note(guild.name, who, `${u.name} failed: ${e.message}`, false); }
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Stopped after too many steps.';
}

// ---- Discord ------------------------------------------------------------
const client = new Client({ intents: [I.Guilds, I.GuildMessages, I.MessageContent] });
const hist = new Map();
client.once('clientReady', c => console.log(`Logged in as ${c.user.tag}`));

client.on('messageCreate', async m => {
  if (m.author.bot || !m.guild || !m.mentions.has(client.user)) return;
  const s = getSettings(m.guild.id);
  if (!s.enabled || (s.channels.length && !s.channels.includes(m.channelId))) return;
  const text = m.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;
  const canAct = m.member.permissions.has('Administrator') || m.member.permissions.has('ManageGuild');
  const h = hist.get(m.channelId) ?? [];
  try {
    await m.channel.sendTyping();
    const reply = await runAgent({ guild: m.guild, channel: m.channel, text: `${m.member.displayName}: ${text}`, history: h, canAct, who: m.author.tag });
    h.push({ role: 'user', content: `${m.member.displayName}: ${text}` }, { role: 'assistant', content: reply });
    hist.set(m.channelId, h.slice(-10));
    for (let i = 0; i < reply.length; i += 1990) await m.reply(reply.slice(i, i + 1990));
  } catch (e) { note(m.guild.name, m.author.tag, `Error: ${e.message}`, false); m.reply('Something went wrong. Check the dashboard activity log.').catch(() => {}); }
});

// ---- Dashboard API ------------------------------------------------------
const H = s => crypto.createHash('sha256').update(s).digest();
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/api', (req, res, next) => crypto.timingSafeEqual(H(req.get('x-token') || ''), H(DASHBOARD_PASSWORD)) ? next() : res.status(401).json({ error: 'Wrong password' }));

app.get('/api/state', (req, res) => res.json({
  bot: { tag: client.user?.tag, ping: client.ws.ping, uptime: Math.round(process.uptime()) },
  models: MODELS, actions: ACTIONS, risky: RISKY, log,
  guilds: client.guilds.cache.map(g => ({
    id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), members: g.memberCount, settings: getSettings(g.id),
    channels: g.channels.cache.filter(c => c.type === ChannelType.GuildText).map(c => ({ id: c.id, name: c.name })),
  })),
}));

app.post('/api/settings/:id', (req, res) => {
  const cur = getSettings(req.params.id), b = req.body;
  if (typeof b.enabled === 'boolean') cur.enabled = b.enabled;
  if (MODELS.includes(b.model)) cur.model = b.model;
  if (typeof b.personality === 'string') cur.personality = b.personality.slice(0, 2000);
  if (Array.isArray(b.channels)) cur.channels = b.channels.map(String);
  if (b.actions) for (const k of Object.keys(ACTIONS)) if (typeof b.actions[k] === 'boolean') cur.actions[k] = b.actions[k];
  save(); res.json(cur);
});

app.post('/api/command', async (req, res) => {
  try {
    const g = client.guilds.cache.get(req.body.guildId) ?? fail('Server not found');
    const ch = g.channels.cache.get(req.body.channelId) ?? g.systemChannel ?? g.channels.cache.find(c => c.type === ChannelType.GuildText) ?? fail('No text channel');
    res.json({ reply: await runAgent({ guild: g, channel: ch, text: String(req.body.text).slice(0, 2000), canAct: true, who: 'Dashboard' }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log('Dashboard on port', process.env.PORT || 3000));
client.login(DISCORD_TOKEN);
