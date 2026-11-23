// One-off pairing helper: links Hermes as a companion device on the bot's
// WhatsApp account using a pairing code (no QR scan), writing credentials
// into the exact session dir the Hermes WhatsApp bridge uses
// (~/.hermes/whatsapp/session). After this exits with CONNECTED, the
// gateway's own bridge reuses the saved session as-is.
//
// The pairing code is requested when the server signals readiness (the
// 'qr' connection update) — requesting it on a fixed timer races the
// handshake and WhatsApp closes the connection.
//
// NOTE: use Baileys 6.7.x for pairing. With Baileys 7.0.0-rc13 the code
// registration is rejected by WhatsApp's server (IQ error 400 bad-request)
// and the phone refuses every code. A session created by 6.7.x is loaded
// fine by the rc13 bridge at runtime.
//
// Usage: node pair.mjs <phone digits, e.g. 6281234567890>
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'node:path';
import os from 'node:os';

const phone = (process.argv[2] || '').replace(/\D/g, '');
if (!phone) {
  console.error('ERR: phone number argument missing');
  process.exit(2);
}

const SESSION_DIR = path.join(os.homedir(), '.hermes', 'whatsapp', 'session');
const logger = pino({ level: 'silent' });
const DEADLINE = Date.now() + 6 * 60 * 1000;

let codePrinted = false;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr && !state.creds.registered && !codePrinted) {
      codePrinted = true;
      try {
        const code = await sock.requestPairingCode(phone);
        console.log('PAIRING_CODE:' + code);
      } catch (e) {
        console.error('ERR: requestPairingCode failed: ' + (e?.message || e));
        codePrinted = false; // allow retry after reconnect
        try { sock.end(undefined); } catch {}
      }
      return;
    }

    if (connection === 'open') {
      console.log('CONNECTED:' + (sock.user?.id || 'unknown'));
      setTimeout(() => process.exit(0), 2500);
    } else if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log('CLOSED:' + status);
      if (status === DisconnectReason.loggedOut) {
        console.error('ERR: logged out');
        process.exit(5);
      }
      // 515 (restartRequired) right after pairing is normal: reconnect
      // with the saved credentials and the connection opens registered.
      if (Date.now() < DEADLINE) {
        setTimeout(() => connect().catch(() => process.exit(6)), 3000);
      } else {
        process.exit(6);
      }
    }
  });
}

setTimeout(() => {
  console.error('ERR: timed out waiting for pairing');
  process.exit(7);
}, 6 * 60 * 1000);

connect().catch((e) => {
  console.error('ERR: ' + (e?.message || e));
  process.exit(1);
});
