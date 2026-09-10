const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const Docker = require('dockerode');
const httpProxy = require('http-proxy');
const YAML = require('yaml');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const sessions = new Map();
const port = Number(process.env.PORT || 3000);
const idleTimeoutMs = Number(process.env.SESSION_IDLE_SECONDS || 120) * 1000;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_SECONDS || 90) * 1000;
const maxVolumesPerStack = 4;
const volumeSizeMb = 128;
const previewTargetHost = process.env.PREVIEW_TARGET_HOST || '127.0.0.1';
const staticRoot = __dirname;
const proxy = httpProxy.createProxyServer({ changeOrigin: true, xfwd: true, selfHandleResponse: true });
const forbiddenComposeKeys = ['build', 'privileged', 'network_mode', 'pid', 'ipc', 'devices', 'cap_add', 'cap_drop', 'security_opt', 'container_name', 'restart'];

function log(message, sessionId = '') { console.log(`[${new Date().toISOString()}]${sessionId ? ` [${sessionId}]` : ''} ${message}`); }
function json(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }

proxy.on('proxyRes', (proxyRes, req, res) => {
  const sessionId = req.previewSessionId;
  const prefix = sessionId ? `/preview/${sessionId}` : '';
  const headers = { ...proxyRes.headers };
  if (prefix && headers.location) {
    try {
      const location = new URL(headers.location, `http://${req.headers.host || 'localhost'}`);
      headers.location = `${prefix}${location.pathname}${location.search}${location.hash}`;
    } catch {
      if (String(headers.location).startsWith('/')) headers.location = `${prefix}${headers.location}`;
    }
  }
  if (prefix && headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map((cookie) => cookie.replace(/Path=\//gi, `Path=${prefix}/`));
  const contentType = String(headers['content-type'] || '');
  if (!prefix || !contentType.includes('text/html')) {
    res.writeHead(proxyRes.statusCode || 502, headers);
    return proxyRes.pipe(res);
  }
  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    let body = Buffer.concat(chunks).toString('utf8');
    body = body.replace(/(href|src|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}/`);
    body = body.replace(/url\(\/(?!\/)/gi, `url(${prefix}/`);
    delete headers['content-length'];
    res.writeHead(proxyRes.statusCode || 200, headers);
    res.end(body);
  });
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 256 * 1024) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function safeImageName(image) { return typeof image === 'string' && image.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(image); }
function parseEnvText(text = '') {
  const env = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Variable de entorno inválida: ${line}`);
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function normalizeEnv(value = {}, overrides = {}) {
  const env = {};
  if (Array.isArray(value)) for (const item of value) { const index = String(item).indexOf('='); if (index > 0) env[String(item).slice(0, index)] = String(item).slice(index + 1); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) env[key] = item == null ? '' : String(item);
  return { ...env, ...overrides };
}

function interpolate(value, env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_, key, fallback) => env[key] ?? fallback ?? '');
}

function parsePortSpec(value) {
  const parts = String(value).replace(/\/tcp$|\/udp$/, '').split(':');
  const containerPort = Number(parts.at(-1));
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new Error(`Puerto Compose inválido: ${value}`);
  return containerPort;
}

function parseVolumeSpec(value) {
  if (value && typeof value === 'object') {
    if (value.type !== 'volume' || !value.source || !value.target) throw new Error('Solo se permiten volúmenes Docker nombrados, no bind mounts ni tmpfs.');
    return { source: String(value.source), target: String(value.target), readOnly: Boolean(value.read_only) };
  }
  const parts = String(value).split(':');
  if (parts.length < 2 || parts.length > 3) throw new Error(`Volumen inválido: ${value}`);
  const [source, target, mode] = parts;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source) || !target.startsWith('/')) throw new Error(`Solo se permiten volúmenes Docker nombrados: ${value}`);
  return { source, target, readOnly: mode === 'ro' };
}

function normalizeComposeIndentation(text) {
  const lines = String(text).split(/\r?\n/);
  const normalized = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)volumes:\s*$/);
    normalized.push(line);
    if (!match) continue;
    const indent = match[1];
    let next = index + 1;
    while (next < lines.length && (lines[next].trim() === '' || lines[next].startsWith(`${indent}- `))) {
      normalized.push(lines[next].trim() === '' ? lines[next] : `  ${lines[next]}`);
      index = next;
      next += 1;
    }
  }
  return normalized.join('\n');
}

function parseCompose(composeText, overridesText) {
  let document;
  const source = String(composeText ?? '').replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('El docker-compose.yml está vacío.');
  try { document = YAML.parse(normalizeComposeIndentation(source)); } catch (error) {
    throw new Error(`YAML inválido: ${error.message}. Revisá la indentación de volumes; dentro del servicio debe quedar como "- nombre:/ruta".`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('El Compose debe ser un objeto YAML con una sección services.');
  }
  if (!document.services || typeof document.services !== 'object' || Array.isArray(document.services)) {
    const keys = Object.keys(document);
    throw new Error(`El Compose debe tener una sección services. Claves encontradas: ${keys.length ? keys.join(', ') : '(ninguna)'}.`);
  }
  const overrides = parseEnvText(overridesText);
  const services = Object.entries(document.services).map(([name, raw]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || !raw || typeof raw !== 'object') throw new Error(`Servicio inválido: ${name}`);
    const forbidden = forbiddenComposeKeys.find((key) => Object.hasOwn(raw, key));
    if (forbidden) throw new Error(`La opción '${forbidden}' no está permitida por seguridad.`);
    if (!safeImageName(raw.image)) throw new Error(`El servicio '${name}' debe usar una imagen Docker válida. 'build' no está soportado.`);
    const ports = Array.isArray(raw.ports) ? raw.ports : [];
    if (ports.length > 1) throw new Error(`El servicio '${name}' tiene varios puertos; el MVP expone uno por stack.`);
    const dependencies = Array.isArray(raw.depends_on) ? raw.depends_on : Object.keys(raw.depends_on || {});
    const serviceEnv = normalizeEnv(raw.environment, overrides);
    return {
      name,
      image: interpolate(raw.image, { ...overrides, ...serviceEnv }),
      port: ports[0] ? parsePortSpec(interpolate(ports[0], { ...overrides, ...serviceEnv })) : null,
      env: Object.entries(serviceEnv).map(([key, value]) => `${key}=${interpolate(value, { ...overrides, ...serviceEnv })}`),
      command: raw.command == null ? undefined : Array.isArray(raw.command) ? raw.command.map((item) => interpolate(item, serviceEnv)) : ['/bin/sh', '-c', interpolate(raw.command, serviceEnv)],
      workingDir: raw.working_dir ? String(raw.working_dir) : undefined,
      dependsOn: dependencies,
      volumes: Array.isArray(raw.volumes) ? raw.volumes.map(parseVolumeSpec) : [],
    };
  });
  const exposed = services.filter((service) => service.port);
  if (exposed.length !== 1) throw new Error('El Compose debe exponer exactamente un servicio web mediante ports.');
  const volumeCount = services.reduce((total, service) => total + service.volumes.length, 0);
  if (volumeCount > maxVolumesPerStack) throw new Error(`El stack supera el límite de ${maxVolumesPerStack} volúmenes temporales.`);
  const byName = new Map(services.map((service) => [service.name, service]));
  for (const service of services) for (const dependency of service.dependsOn) if (!byName.has(dependency)) throw new Error(`El servicio '${service.name}' depende de '${dependency}', que no existe.`);
  const ordered = [];
  const pending = [...services];
  while (pending.length) {
    const index = pending.findIndex((service) => service.dependsOn.every((dependency) => ordered.some((item) => item.name === dependency)));
    if (index === -1) throw new Error('Dependencias circulares en el Compose.');
    ordered.push(pending.splice(index, 1)[0]);
  }
  return { services: ordered, publicService: exposed[0].name };
}

function publicSession(session) {
  return {
    id: session.id, kind: session.kind, image: session.image || null, publicService: session.publicService || null,
    services: session.services || [], status: session.status, error: session.error || null,
    previewUrl: session.status === 'ready' ? `/preview/${session.id}/` : null,
    expiresInSeconds: Math.max(0, Math.ceil((idleTimeoutMs - (Date.now() - session.lastSeen)) / 1000)),
  };
}

function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (error, stream) => {
      if (error) return reject(error);
      docker.modem.followProgress(stream, (progressError) => (progressError ? reject(progressError) : resolve()));
    });
  });
}

async function containerOutput(container) {
  try { const logs = await container.logs({ stdout: true, stderr: true, tail: 40 }); return logs.toString().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(-3000); } catch { return ''; }
}

async function removeContainer(container) { if (!container) return; try { await container.remove({ force: true, v: true }); } catch { /* already gone */ } }
async function removeRuntime(session) {
  await Promise.all((session.containers || []).map(removeContainer));
  if (session.network) { try { await session.network.remove(); } catch { /* already gone */ } }
  await Promise.all((session.volumes || []).map(async (volume) => { try { await volume.remove({ force: true }); } catch { /* already gone */ } }));
}

function canConnect(host, portNumber) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: portNumber });
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; socket.destroy(); resolve(result); };
    socket.setTimeout(1200);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function waitForServicePort(session, container, host, portNumber) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= startupTimeoutMs) {
    const details = await container.inspect();
    if (!details.State.Running) throw new Error(`El servicio web terminó al iniciar. ${await containerOutput(container)}`.trim());
    if (await canConnect(host, portNumber)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`El servicio no abrió el puerto ${portNumber} dentro de ${startupTimeoutMs / 1000} segundos.`);
}

async function destroySession(session) {
  if (!session || session.destroyed) return;
  session.destroyed = true;
  sessions.delete(session.id);
  log('Sesión destruida', session.id);
  await removeRuntime(session);
}

function runtimeOptions(session, service, networkName, publicPort) {
  const exposed = service.port ? { [`${service.port}/tcp`]: {} } : {};
  const bindings = service.name === session.publicService ? { [`${publicPort}/tcp`]: [{ HostPort: '0' }] } : {};
  return {
    Image: service.image,
    name: `ephemeral-deploy-${session.id}-${service.name}`,
    // Temporary named volumes are created root-owned. Running as container
    // root lets image entrypoints initialize their own config directories;
    // the container remains isolated and is still non-privileged.
    User: '0:0',
    Labels: { 'ephemeral-deploy': 'true', 'ephemeral-deploy-session': session.id, 'ephemeral-deploy-service': service.name },
    Env: service.env,
    Cmd: service.command,
    WorkingDir: service.workingDir,
    ExposedPorts: exposed,
    HostConfig: {
      AutoRemove: false, PortBindings: bindings, Memory: 256 * 1024 * 1024, NanoCpus: 500000000, PidsLimit: 128,
      CapDrop: ['ALL'], CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
    },
    Mounts: service.mounts || [],
    NetworkingConfig: { EndpointsConfig: { [networkName]: { Aliases: [service.name] } } },
  };
}

async function startStackSession(session, composeText, envText) {
  try {
    session.status = 'parsing';
    const stack = parseCompose(composeText, envText);
    session.services = stack.services.map((service) => service.name);
    session.publicService = stack.publicService;
    session.status = 'pulling';
    const images = [...new Set(stack.services.map((service) => service.image))];
    for (const image of images) { log(`Descargando ${image}`, session.id); await pullImage(image); }
    if (session.destroyed) return;
    const networkName = `ephemeral-net-${session.id}`;
    session.network = docker.getNetwork((await docker.createNetwork({ Name: networkName, Labels: { 'ephemeral-deploy': 'true', 'ephemeral-deploy-session': session.id } })).Id);
    session.status = 'starting';
    const publicService = stack.services.find((service) => service.name === stack.publicService);
    for (const service of stack.services) {
      service.mounts = [];
      for (let index = 0; index < service.volumes.length; index += 1) {
        const volume = service.volumes[index];
        const volumeName = `ephemeral-vol-${session.id}-${service.name}-${index}`;
        const dockerVolume = docker.getVolume(volumeName);
        await docker.createVolume({ Name: volumeName, Labels: { 'ephemeral-deploy': 'true', 'ephemeral-deploy-session': session.id } });
        session.volumes.push(dockerVolume);
        service.mounts.push({ Type: 'volume', Source: volumeName, Target: volume.target, ReadOnly: volume.readOnly });
      }
      log(`Iniciando servicio ${service.name}`, session.id);
      const container = await docker.createContainer(runtimeOptions(session, service, networkName, publicService.port));
      session.containers.push(container);
      await container.start();
    }
    const publicContainer = session.containers[stack.services.findIndex((service) => service.name === stack.publicService)];
    const details = await publicContainer.inspect();
    if (!details.State.Running) throw new Error(`El servicio web terminó al iniciar. ${await containerOutput(publicContainer)}`.trim());
    const binding = details.NetworkSettings.Ports?.[`${publicService.port}/tcp`]?.[0];
    if (!binding?.HostPort) throw new Error('No se pudo detectar el puerto publicado del servicio web.');
    session.hostPort = Number(binding.HostPort);
    log(`Esperando que el servicio web acepte conexiones en ${previewTargetHost}:${session.hostPort}`, session.id);
    await waitForServicePort(session, publicContainer, previewTargetHost, session.hostPort);
    session.status = 'ready';
    log(`Stack listo en ${previewTargetHost}:${session.hostPort}`, session.id);
  } catch (error) {
    session.status = 'error'; session.error = error.message || 'Error desconocido al iniciar el stack.'; session.errorAt = Date.now();
    log(`Error: ${session.error}`, session.id); await removeRuntime(session); session.containers = [];
  }
}

async function startImageSession(session) {
  return startStackSession(session, `services:\n  app:\n    image: ${session.image}\n    ports:\n      - "${session.port}:${session.port}"\n`, session.envText || '');
}

async function cleanupOrphans() {
  try {
    const containers = await docker.listContainers({ all: true, filters: { label: ['ephemeral-deploy=true'] } });
    await Promise.all(containers.map((info) => docker.getContainer(info.Id).remove({ force: true, v: true }).catch(() => {})));
    const networks = await docker.listNetworks({ filters: { label: ['ephemeral-deploy=true'] } });
    await Promise.all(networks.map((info) => docker.getNetwork(info.Id).remove().catch(() => {})));
    const volumes = await docker.listVolumes({ filters: { label: ['ephemeral-deploy=true'] } });
    await Promise.all((volumes.Volumes || []).map((info) => docker.getVolume(info.Name).remove({ force: true }).catch(() => {})));
    if (containers.length || networks.length || (volumes.Volumes || []).length) log(`Limpiados ${containers.length} contenedores, ${networks.length} redes y ${(volumes.Volumes || []).length} volúmenes huérfanos`);
  } catch (error) { log(`No se pudieron limpiar huérfanos: ${error.message}`); }
}

async function sessionLogs(session) {
  const chunks = [];
  for (let index = 0; index < (session.containers || []).length; index += 1) {
    try { const output = await containerOutput(session.containers[index]); if (output) chunks.push(`[${session.services?.[index] || 'container'}]\n${output}`); } catch { /* ignore */ }
  }
  return chunks.join('\n\n');
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(staticRoot, requested);
  if (!file.startsWith(staticRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, pathname) {
  if (req.method === 'POST' && (pathname === '/api/sessions' || pathname === '/api/stacks')) {
    try {
      const body = await readBody(req);
      const isStack = pathname === '/api/stacks';
      if (isStack && typeof body.compose !== 'string') return json(res, 400, { error: 'Falta el contenido del docker-compose.yml.' });
      const image = body.image?.trim(); const containerPort = Number(body.port || 80);
      if (!isStack && !safeImageName(image)) return json(res, 400, { error: 'Imagen Docker inválida.' });
      if (!isStack && (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535)) return json(res, 400, { error: 'El puerto debe ser un entero entre 1 y 65535.' });
      const session = { id: crypto.randomUUID(), kind: isStack ? 'compose' : 'image', image: isStack ? null : image, port: containerPort, status: 'queued', lastSeen: Date.now(), containers: [], volumes: [], envText: body.env || '' };
      sessions.set(session.id, session); log(`Nueva sesión ${session.kind}`, session.id);
      if (isStack) startStackSession(session, body.compose, body.env || ''); else startImageSession(session);
      return json(res, 202, publicSession(session));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  const match = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(heartbeat|logs))?$/);
  if (!match) return json(res, 404, { error: 'Endpoint no encontrado.' });
  const session = sessions.get(match[1]);
  if (!session) return json(res, 404, { error: 'Sesión expirada o inexistente. Si el servicio se reinició, las sesiones anteriores se eliminaron.' });
  session.lastSeen = Date.now();
  if (req.method === 'GET' && match[2] === 'logs') return json(res, 200, { logs: await sessionLogs(session) });
  if (req.method === 'GET') return json(res, 200, publicSession(session));
  if (req.method === 'POST' && match[2] === 'heartbeat') return json(res, 200, publicSession(session));
  if (req.method === 'DELETE') { await destroySession(session); return json(res, 200, { ok: true }); }
  return json(res, 405, { error: 'Método no permitido.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const pathname = url.pathname;
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  const previewMatch = pathname.match(/^\/preview\/([a-f0-9-]+)(\/.*)?$/);
  if (previewMatch) {
    const session = sessions.get(previewMatch[1]);
    if (!session || session.status !== 'ready') return json(res, 404, { error: 'Preview no disponible.' });
    session.lastSeen = Date.now(); req.previewSessionId = session.id; const previewPath = previewMatch[2] || '/';
    // The target includes the rewritten preview path. Keeping ignorePath=false
    // makes http-proxy use that path instead of forwarding /preview/:id/... to
    // the temporary container.
    return proxy.web(req, res, { target: `http://${previewTargetHost}:${session.hostPort}${previewPath}`, proxyTimeout: 10000, headers: { 'accept-encoding': 'identity' } }, (error) => { if (!res.headersSent) json(res, 502, { error: `No se pudo acceder al preview: ${error.message}` }); });
  }
  return serveStatic(res, pathname);
});

setInterval(() => { for (const session of sessions.values()) { if (session.status === 'error' && Date.now() - session.errorAt > 120000) destroySession(session); else if (session.status !== 'error' && Date.now() - session.lastSeen > idleTimeoutMs) destroySession(session); } }, 30000).unref();
cleanupOrphans().finally(() => server.listen(port, () => log(`Ephemeral Deploy escuchando en http://localhost:${port}`)));
process.on('SIGTERM', async () => { await Promise.all([...sessions.values()].map(destroySession)); server.close(() => process.exit(0)); });
