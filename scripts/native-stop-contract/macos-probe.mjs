/** Actual local OS probes. No Provider, daemon, or production stop proof. */
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, chmod, realpath, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const source = fileURLToPath(new URL('./macos-adversary.c', import.meta.url));
const repository = resolve(dirname(source), '../..');
const digest = (data) => createHash('sha256').update(data).digest('hex');

function present(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function observe(plan, { mode, control, beforeRelease }) {
  const child = spawn(plan.command, plan.args, {
    ...plan.options,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let stdout = '', stderr = '', exited, failed, observationReady;
  const rootExit = new Promise((yes, no) => { exited = yes; failed = no; });
  const observed = new Promise(yes => { observationReady = yes; });
  const closed = new Promise(yes => {
    child.once('close', (code, signal) => { observationReady(); yes({ code, signal }); });
    child.once('error', error => { observationReady(); yes({ error: error.message }); });
  });
  child.once('exit', (code, signal) => exited({ code, signal }));
  child.once('error', failed);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      try {
        const message = JSON.parse(line);
        messages.push(message);
        // The root's final marker follows the leaf opening the independent
        // FIFO. Node can emit exit before consuming the separate stdout pipe.
        if (['root-exiting', 'kqueue-observed', 'launch-error'].includes(message.event)) {
          observationReady();
        }
      } catch { /* Non-JSON output cannot establish readiness. */ }
    }
  });
  const watchdog = setTimeout(() => {
    child.stdin.destroy();
    // Never kill a PID reconstructed from a child's diagnostic message.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 12_000);
  try {
    const rootResult = await rootExit;
    await observed;
    const leaf = messages.find(message => message.event === 'leaf-ready');
    const kernelEvent = messages.find(message => message.event === 'kqueue-observed');
    const before = leaf ? {
      rootExitedBeforeRelease: true,
      originalGroupAbsent: !present(-child.pid),
      descendantAlive: present(leaf.pid),
    } : {};
    if (leaf && beforeRelease) await beforeRelease();
    if (leaf) await control.write('W');
    child.stdin.end();
    const finalResult = await closed;
    return {
      mode, rootResult, finalResult, ...before, leaf, kernelEvent,
      completion: messages.find(message => message.event === 'leaf-completed'),
      launchError: messages.find(message => message.event === 'launch-error'),
      error: stderr.trim().slice(0, 1500) || undefined,
    };
  } finally {
    clearTimeout(watchdog);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

export async function probeMacosStopContract() {
  if (process.platform !== 'darwin') {
    return { platform: process.platform, supported: false, verifiedDescendantStop: false };
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flyx-macos-stop-contract-')));
  const workspace = join(root, 'workspace');
  const state = join(root, 'native-state');
  const privateRoot = join(root, 'host-private');
  const binary = join(root, 'adversary');
  const privateFile = join(privateRoot, 'sentinel');
  const heldFile = join(workspace, 'held-open');
  const gateFile = join(root, 'control-fifo');
  let boundary, control;
  try {
    await Promise.all([workspace, state, privateRoot].map(path => mkdir(path, { mode: 0o700 })));
    await writeFile(privateFile, 'fixture-private-only', { mode: 0o600 });
    await run('/usr/bin/mkfifo', ['-m', '600', gateFile], { timeout: 5000 });
    control = await open(gateFile, constants.O_RDWR);
    await run('/usr/bin/xcrun', [
      'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-D_DARWIN_C_SOURCE', '-fblocks', '-lEndpointSecurity', source, '-o', binary,
    ], { timeout: 20_000, maxBuffer: 128 * 1024 });

    const modulePath = join(repository, 'apps/mvp-host/dist/lifecycle/native-execution-boundary.js');
    const { prepareNativeExecutionBoundary } = await import(pathToFileURL(modulePath).href);
    const assessment = await prepareNativeExecutionBoundary({
      workspaceRoot: workspace, nativeStateRoots: [state], privateRoots: [privateRoot], temporaryRoot: root,
    });
    if (!assessment.ready) throw new Error('Actual private boundary unavailable: ' + assessment.code);
    boundary = assessment.boundary;
    const request = mode => ({
      command: binary, args: [mode, privateFile, heldFile, gateFile],
      cwd: workspace, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const plan = boundary.plan(request('setsid'));
    const profile = await readFile(plan.args[1], 'utf8');
    const cases = [];
    for (const mode of ['setsid', 'setpgid', 'double-fork', 'spawn-setsid', 'kqueue-track']) {
      cases.push(await observe(boundary.plan(request(mode)), { mode, control }));
    }

    const policyCases = [];
    for (const operation of [
      'process-setsid', 'process-setpgid', 'process-set-session', 'process-info-setcontrol', 'process-fork',
    ]) {
      const path = join(root, operation + '.sb');
      await writeFile(path, profile + '\n(deny ' + operation + ')\n', { mode: 0o600 });
      const results = [];
      for (const mode of operation === 'process-fork' ? ['setsid', 'spawn-setsid'] : ['setsid']) {
        results.push(await observe({
          command: '/usr/bin/sandbox-exec',
          args: ['-f', path, '--', binary, mode, privateFile, heldFile, gateFile],
          options: { cwd: workspace, env: { PATH: '/usr/bin:/bin' } },
        }, { mode, control }));
      }
      policyCases.push({ operation, results });
    }

    // Probe capability only: no subscription, privilege change, or daemon.
    const endpoint = JSON.parse((await run(binary, ['endpoint-security'], {
      timeout: 5000, maxBuffer: 16 * 1024,
    })).stdout.trim());
    const sdk = (await run('/usr/bin/xcrun', ['--show-sdk-path'], { timeout: 5000 })).stdout.trim();
    const eventHeader = await readFile(join(sdk, 'usr/include/sys/event.h'), 'utf8');
    const observer = {
      noteTrackUnsupportedHeader: eventHeader.includes(
        'NOTE_TRACK, NOTE_TRACKERR, and NOTE_CHILD are no longer supported as of 10.5',
      ),
      endpointSecurity: endpoint,
    };

    const revoked = join(root, 'revoked-workspace');
    const revokedCase = await observe(boundary.plan(request('setsid')), {
      mode: 'held-fd-after-rename-and-chmod', control,
      beforeRelease: async () => { await rename(workspace, revoked); await chmod(revoked, 0o000); },
    });
    await chmod(revoked, 0o700);
    for (const entry of [...cases, ...policyCases.flatMap(policy => policy.results), revokedCase]) {
      if (entry.error) entry.error = entry.error.replaceAll(root, '[fixture]');
    }
    return {
      platform: process.platform, kernel: release(),
      macos: (await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(),
      compiler: (await run('/usr/bin/xcrun', ['clang', '--version'])).stdout.split('\n')[0],
      sourceDigest: digest(await readFile(source)),
      backendDigest: assessment.proof.backendDigest, policyDigest: assessment.proof.policyDigest,
      privateBoundaryReady: true, verifiedDescendantStop: assessment.proof.verifiedDescendantStop,
      treeIsolation: assessment.proof.treeIsolation, cases, policyCases, observer,
      revokedWorkspace: revokedCase, heldContents: await readFile(join(revoked, 'held-open'), 'utf8'),
    };
  } finally {
    await control?.close();
    await boundary?.dispose().catch(() => {});
    await chmod(join(root, 'revoked-workspace'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  probeMacosStopContract().then(
    report => console.log(JSON.stringify(report, null, 2)),
    error => { console.error(error.message); process.exitCode = 1; },
  );
}
