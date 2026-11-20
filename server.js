const http = require('http');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const MAX_FFA = 8;
const WIN_KILLS = 10;
const RESPAWN_MS = 2500;
const ROOMS = new Map();
const WAITING_DUELS = [];
let ffaRoomId = null;

function safeName(value) {
  return String(value || 'RANGER').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 16) || 'RANGER';
}
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function roomPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, slot: p.slot, score: p.score, deaths: p.deaths,
    state: p.state
  }));
}
function sendAmmo(player) {
  send(player.ws, { type: 'ammo', ammo: player.ammo });
}
function scoreboard(room) {
  for (const p of room.players.values()) {
    send(p.ws, {
      type: 'scoreboard', players: roomPlayers(room),
      selfScore: p.score, selfDeaths: p.deaths
    });
  }
}
function makeRoom(mode) {
  const room = { id: randomUUID(), mode, players: new Map(), finished: false };
  ROOMS.set(room.id, room);
  return room;
}
function joinRoom(ws, room, name) {
  if (room.players.size >= (room.mode === 'ffa' ? MAX_FFA : 2)) {
    send(ws, { type: 'error', message: 'That match is full. Try again.' });
    return;
  }
  const id = randomUUID();
  const usedSlots = new Set([...room.players.values()].map(p => p.slot));
  let slot = 0; while (usedSlots.has(slot)) slot++;
  const player = {
    id, name, slot, ws, score: 0, deaths: 0, hp: 100,
    ammo: { gun: { mag: 12, reserve: 48 }, sniper: { mag: 5, reserve: 20 } },
    state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0, prone: false, moving: false, dead: false },
    lastStateAt: Date.now(), lastShotAt: 0, reloadUntil: 0, deadUntil: 0, hasState: false
  };
  ws.playerId = id;
  ws.roomId = room.id;
  room.players.set(id, player);
  const joined = {
    type: room.mode === 'duel' ? 'matchFound' : 'joined',
    id, room: room.id, slot, mode: room.mode,
    players: roomPlayers(room)
  };
  send(ws, joined);
  sendAmmo(player);
  for (const other of room.players.values()) {
    if (other.id !== id) send(other.ws, { type: 'playerJoined', player: {
      id, name, slot, score: 0, deaths: 0, state: player.state
    }, players: roomPlayers(room) });
  }
  scoreboard(room);
}
function removeFromQueue(ws) {
  for (let i = WAITING_DUELS.length - 1; i >= 0; i--) {
    if (WAITING_DUELS[i] === ws) WAITING_DUELS.splice(i, 1);
  }
}
function handleJoin(ws, msg) {
  const mode = msg.mode === 'duel' ? 'duel' : msg.mode === 'ffa' ? 'ffa' : null;
  if (!mode) return send(ws, { type: 'error', message: 'Unknown online mode.' });
  const name = safeName(msg.name);
  if (mode === 'ffa') {
    let room = ffaRoomId && ROOMS.get(ffaRoomId);
    if (!room || room.finished || room.players.size >= MAX_FFA) {
      room = makeRoom('ffa');
      ffaRoomId = room.id;
    }
    return joinRoom(ws, room, name);
  }
  removeFromQueue(ws);
  let opponent = null;
  while (WAITING_DUELS.length && !opponent) {
    const candidate = WAITING_DUELS.shift();
    if (candidate.readyState === WebSocket.OPEN && !candidate.roomId) opponent = candidate;
  }
  if (!opponent) {
    ws.waitingName = name;
    WAITING_DUELS.push(ws);
    send(ws, { type: 'waiting' });
    return;
  }
  const room = makeRoom('duel');
  joinRoom(opponent, room, opponent.waitingName || 'RANGER');
  joinRoom(ws, room, name);
}
function validNumber(n, min, max) {
  return Number.isFinite(n) && n >= min && n <= max;
}
function handleState(ws, msg) {
  const room = ROOMS.get(ws.roomId);
  const player = room && room.players.get(ws.playerId);
  const s = msg.state;
  const now = Date.now();
  if (!player || !s || room.finished || now < player.deadUntil) return;
  if (now - player.lastStateAt < 25) return;
  if (![s.x,s.y,s.z,s.yaw,s.pitch].every(Number.isFinite)) return;
  if (!validNumber(s.x, -135, 135) || !validNumber(s.z, -135, 135) || !validNumber(s.y, -15, 40)) return;
  if (player.hasState) {
    const elapsed = Math.max(0.025, (now - player.lastStateAt) / 1000);
    const moved = Math.hypot(s.x-player.state.x, s.z-player.state.z, (s.y-player.state.y)*0.6);
    if (moved > 12 * elapsed + 2.5) return;
  }
  player.state = {
    x: s.x, y: s.y, z: s.z,
    yaw: Math.max(-Math.PI * 4, Math.min(Math.PI * 4, s.yaw)),
    pitch: Math.max(-1, Math.min(1, s.pitch)),
    crouch: Math.max(0, Math.min(1, Number(s.crouch) || 0)),
    prone: !!s.prone, moving: !!s.moving, dead: false
  };
  player.lastStateAt = now;
  player.hasState = true;
  for (const other of room.players.values()) {
    if (other.id !== player.id) send(other.ws, { type: 'state', id: player.id, state: player.state, score: player.score });
  }
}
function raySphere(origin, dir, center, radius) {
  const ox = origin.x-center.x, oy = origin.y-center.y, oz = origin.z-center.z;
  const b = ox*dir.x + oy*dir.y + oz*dir.z;
  const c = ox*ox + oy*oy + oz*oz - radius*radius;
  const disc = b*b-c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  let t = -b-root;
  if (t < 0) t = -b+root;
  return t >= 0 ? t : null;
}
function handleShot(ws, msg) {
  const room = ROOMS.get(ws.roomId);
  const attacker = room && room.players.get(ws.playerId);
  const now = Date.now();
  if (!room || !attacker || room.finished || now < attacker.deadUntil) return;
  const weapon = msg.weapon === 'sniper' ? 'sniper' : msg.weapon === 'gun' ? 'gun' : null;
  const o = msg.origin, d = msg.dir;
  if (!weapon || !o || !d || ![o.x,o.y,o.z,d.x,d.y,d.z].every(Number.isFinite)) return;
  const len = Math.hypot(d.x,d.y,d.z);
  if (len < 0.9 || len > 1.1 || !validNumber(o.x,-145,145) || !validNumber(o.y,-20,50) || !validNumber(o.z,-145,145)) return;
  // The firing point must stay near the player's current camera position.
  const cameraOffset = Math.hypot(o.x-attacker.state.x, o.y-(attacker.state.y+1.5), o.z-attacker.state.z);
  if (!attacker.hasState || cameraOffset > 8 || now-attacker.lastStateAt > 1200) return;
  const interval = weapon === 'sniper' ? 900 : 250;
  if (now-attacker.lastShotAt < interval || now < attacker.reloadUntil) return;
  const ammo = attacker.ammo[weapon];
  if (!ammo || ammo.mag <= 0) { send(attacker.ws,{type:'empty',weapon}); sendAmmo(attacker); return; }
  ammo.mag -= 1;
  attacker.lastShotAt = now;
  sendAmmo(attacker);

  const direction = {x:d.x/len,y:d.y/len,z:d.z/len};
  const maxRange = weapon === 'sniper' ? 100 : 45;
  const requestedTarget = room.players.get(String(msg.target || ''));
  if (!requestedTarget || requestedTarget.id === attacker.id || requestedTarget.deadUntil > now) {
    send(attacker.ws,{type:'shotResult',hit:false});
    return;
  }
  // Server independently checks the reported target against simple player hit volumes.
  const candidates = [];
  for (const target of room.players.values()) {
    if (target.id === attacker.id || target.deadUntil > now || !target.hasState) continue;
    const base = target.state;
    const headDist = raySphere(o,direction,{x:base.x,y:base.y+1.62,z:base.z},0.23);
    const bodyDist = raySphere(o,direction,{x:base.x,y:base.y+1.02,z:base.z},0.52);
    let distance = null, part = null;
    if (headDist !== null && headDist <= maxRange) { distance=headDist; part='head'; }
    if (bodyDist !== null && bodyDist <= maxRange && (distance===null || bodyDist<distance)) { distance=bodyDist; part='body'; }
    if (distance !== null) candidates.push({target,distance,part});
  }
  candidates.sort((a,b)=>a.distance-b.distance);
  const hit = candidates[0];
  if (!hit || hit.target.id !== requestedTarget.id) {
    send(attacker.ws,{type:'shotResult',hit:false});
    return;
  }
  const target = hit.target;
  const damage = weapon === 'sniper' ? (hit.part === 'head' ? 100 : 30) : (hit.part === 'head' ? 35 : 25);
  target.hp = Math.max(0,target.hp-damage);
  send(attacker.ws,{type:'shotResult',hit:true,part:hit.part,damage});
  send(target.ws,{type:'damage',hp:target.hp,by:attacker.name});
  if (target.hp > 0) return;

  target.deaths += 1;
  target.deadUntil = now + RESPAWN_MS;
  target.state.dead = true;
  attacker.score += 1;
  send(target.ws,{type:'death',by:attacker.name,deaths:target.deaths});
  send(attacker.ws,{type:'kill',target:target.name,kills:attacker.score});
  for (const other of room.players.values()) {
    if (other.id !== target.id) send(other.ws,{type:'state',id:target.id,state:target.state,score:target.score});
  }
  scoreboard(room);
  if (attacker.score >= WIN_KILLS) {
    room.finished = true;
    for (const p of room.players.values()) send(p.ws,{type:'matchWon',id:attacker.id,name:attacker.name});
  }
}
function handleReload(ws,msg) {
  const room = ROOMS.get(ws.roomId);
  const player = room && room.players.get(ws.playerId);
  const weapon = msg.weapon === 'sniper' ? 'sniper' : msg.weapon === 'gun' ? 'gun' : null;
  if (!player || !weapon || room.finished || Date.now()<player.deadUntil || Date.now()<player.reloadUntil) return;
  const ammo = player.ammo[weapon];
  const capacity = weapon === 'sniper' ? 5 : 12;
  if (!ammo || ammo.mag >= capacity || ammo.reserve <= 0) return;
  player.reloadUntil = Date.now()+900;
  send(player.ws,{type:'reloading'});
  setTimeout(() => {
    const stillHere = ROOMS.get(ws.roomId);
    const current = stillHere && stillHere.players.get(player.id);
    if (!current) return;
    const a = current.ammo[weapon];
    const loaded = Math.min(capacity-a.mag,a.reserve);
    a.mag += loaded; a.reserve -= loaded;
    current.reloadUntil = 0;
    sendAmmo(current);
  }, 900);
}
function handleRespawn(ws) {
  const room = ROOMS.get(ws.roomId);
  const player = room && room.players.get(ws.playerId);
  if (!player || room.finished || !player.deadUntil) return;
  if (Date.now() < player.deadUntil) {
    send(player.ws,{type:'respawnWait',milliseconds:Math.min(600,player.deadUntil-Date.now())});
    return;
  }
  player.deadUntil = 0;
  player.hp = 100;
  player.state.dead = false;
  player.hasState = false;
  send(player.ws,{type:'respawned',slot:player.slot,hp:100});
  scoreboard(room);
}
function leaveRoom(ws) {
  removeFromQueue(ws);
  const room = ROOMS.get(ws.roomId);
  const player = room && room.players.get(ws.playerId);
  if (!room || !player) return;
  room.players.delete(player.id);
  for (const other of room.players.values()) {
    send(other.ws, { type: 'playerLeft', id: player.id, players: roomPlayers(room) });
  }
  if (room.players.size === 0) {
    ROOMS.delete(room.id);
    if (ffaRoomId === room.id) ffaRoomId = null;
  } else {
    scoreboard(room);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, game: 'STEALTH Sector 04 Multiplayer', modes: ['ffa', 'duel'], scoring: 'kills', winKills: WIN_KILLS }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid message.' }); }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'join' && !ws.roomId) return handleJoin(ws, msg);
    if (msg.type === 'state') return handleState(ws, msg);
    if (msg.type === 'shot') return handleShot(ws, msg);
    if (msg.type === 'reload') return handleReload(ws, msg);
    if (msg.type === 'respawn') return handleRespawn(ws);
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
server.listen(PORT, '0.0.0.0', () => console.log(`STEALTH multiplayer server listening on ${PORT}`));
process.on('SIGTERM', () => { clearInterval(heartbeat); server.close(() => process.exit(0)); });
