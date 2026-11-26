import nodemailer from 'nodemailer';

/**
 * Correo saliente por SMTP, configurado por el administrador general.
 * `transport` permite reemplazar el envío en las pruebas.
 */
export function createMailer({ getSetting, transport = null }) {
  const config = () => ({
    host: getSetting('smtpHost'),
    port: Number(getSetting('smtpPort')) || 587,
    security: getSetting('smtpSecurity') || 'starttls',
    user: getSetting('smtpUser'),
    pass: getSetting('smtpPass'),
    from: getSetting('smtpFrom'),
  });
  const ready = () => {
    const c = config();
    return !!(c.host && c.from);
  };

  async function send({ to, subject, text }) {
    const c = config();
    if (!ready()) throw new Error('El correo saliente no está configurado');
    const msg = { from: c.from, to, subject, text };
    if (transport) return transport(msg);
    const t = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.security === 'tls',
      requireTLS: c.security === 'starttls',
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      await t.sendMail(msg);
    } finally {
      t.close();
    }
  }

  return { ready, send, config };
}
