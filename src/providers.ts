import { Resend } from 'resend';
import { Api, GrammyError, HttpError } from 'grammy';
import type { Bindings, MessageInput } from './contracts';

export class DeliveryError extends Error {
  constructor(public code: string, public retryable = false, public uncertain = false, public retryAfter = 0) { super(code); }
}
export async function deliver(env: Bindings, input: MessageInput, key: string): Promise<string> {
  if (input.channel === 'email') {
    const token = env.RESEND_API_KEY;
    if (!token || !env.FROM_EMAIL) throw new DeliveryError('EMAIL_NOT_CONFIGURED');
    let result;
    try {
      const client = new Resend(token);
      const request = client.fetchRequest.bind(client);
      client.fetchRequest = (path, options = {}) => request(path, { ...options, signal: AbortSignal.timeout(30_000) });
      result = await client.emails.send({ from: env.FROM_EMAIL, to: input.to, subject: input.subject,
        text: input.text ?? '', ...(input.html ? { html: input.html } : {}) }, { idempotencyKey: key });
    } catch { throw new DeliveryError('EMAIL_TRANSPORT_ERROR', true, true); }
    if (result.error) {
      const code = result.error.name;
      const retryable = ['rate_limit_exceeded','application_error','internal_server_error','concurrent_idempotent_requests'].includes(code);
      // SDK transport failures can be represented as application_error rather than thrown.
      throw new DeliveryError(`EMAIL_${code}`, retryable, code === 'application_error');
    }
    if (!result.data?.id) throw new DeliveryError('EMAIL_RESPONSE_INVALID', true, true);
    return result.data.id;
  }
  let token: string, chatId: string;
  try { [token, chatId] = await Promise.all([env.TELEGRAM_BOT_TOKEN.get(), input.chatId ? Promise.resolve(input.chatId) : env.TELEGRAM_USER_ID.get()]); }
  catch { throw new DeliveryError('TELEGRAM_NOT_CONFIGURED'); }
  if (!token || !/^-?\d+$/.test(chatId)) throw new DeliveryError('TELEGRAM_NOT_CONFIGURED');
  try {
    const api = new Api(token, { timeoutSeconds: 30 });
    const result = await api.sendMessage(chatId, input.text);
    if (!result || !Number.isSafeInteger(result.message_id)) throw new DeliveryError('TELEGRAM_RESPONSE_INVALID', false, true);
    return String(result.message_id);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    if (error instanceof GrammyError) {
      throw new DeliveryError(`TELEGRAM_${error.error_code}`, error.error_code === 429 || error.error_code >= 500,
        false, error.parameters.retry_after ?? 0);
    }
    // No bot URL, token, provider response or message body enters logs/DB errors.
    throw new DeliveryError(error instanceof HttpError ? 'TELEGRAM_TRANSPORT_ERROR' : 'TELEGRAM_RESPONSE_INVALID', false, true);
  }
}
