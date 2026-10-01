import nodemailer from 'nodemailer';
import type { SmtpConfig } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close(): void;
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport(config.url);
  return {
    async send(message) {
      await transport.sendMail({ from: config.from, ...message });
    },
    close() {
      transport.close();
    },
  };
}
