import nodemailer from "nodemailer";

// Reads SMTP config from env and sends an HTML email with optional CID
// attachments. Throws on failure — caller decides retry policy.
//
// Required env: SMTP_HOST, SMTP_USER, SMTP_PASS.
// Optional: SMTP_PORT (default 587), EMAIL_FROM (default = SMTP_USER).
//
// For Gmail: generate an app password at https://myaccount.google.com/apppasswords
// — regular passwords will not work with 2FA enabled.
export async function sendEmail({ to, subject, html, attachments = [] }) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || user;

  if (!host || !user || !pass) {
    throw new Error(
      "SMTP config missing — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env",
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // SSL only on 465; 587 uses STARTTLS
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
    attachments, // [{ filename, path, cid }] for inline images
  });

  return { messageId: info.messageId, accepted: info.accepted };
}
