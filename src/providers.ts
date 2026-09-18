import webpush from 'web-push';
import { Resend } from 'resend';
import { Api, GrammyError, HttpError } from 'grammy';
import type { Bindings, MessageInput } from './contracts';

export class DeliveryError extends Error {
  constructor(public code: string, public retryable = false, public uncertain = false, public retryAfter = 0) { super(code); }
}
export async function deliver(env: Bindings, input: MessageInput, key: string): Promise<string> {
  if (input.adminTest) {
    const row = await env.DB.prepare('SELECT email,telegram_chat_id FROM notification_settings WHERE user_id=?')
      .bind(input.adminTest.userId).first<{email:string;telegram_chat_id:string}>();
    if (input.channel === 'email' && (!row?.email || input.to.length !== 1 || input.to[0] !== row.email)
      || input.channel === 'telegram' && (!row?.telegram_chat_id || input.chatId !== row.telegram_chat_id)
      || input.channel === 'webpush' && input.userId !== input.adminTest.userId) throw new DeliveryError('TEST_CONTACT_CHANGED');
  }
  if(input.notification) {
    const {userId,category}=input.notification;
    const row=await env.DB.prepare('SELECT subscriptions,email,telegram_chat_id FROM notification_settings WHERE user_id=?').bind(userId)
      .first<{subscriptions:string;email:string;telegram_chat_id:string}>();
    if(!row || !JSON.parse(row.subscriptions)[category]?.includes(input.channel))throw new DeliveryError('NOTIFICATION_UNSUBSCRIBED');
    if(input.channel==='email' && input.to.some(email=>email!==row.email) || input.channel==='telegram' && input.chatId!==row.telegram_chat_id)
      throw new DeliveryError('NOTIFICATION_CONTACT_CHANGED');
    if(!env.NOTIFICATION_SOURCE)throw new DeliveryError('NOTIFICATION_ELIGIBILITY_UNAVAILABLE',true);
    let users:{id:string;categories:string[]}[];
    try {
      const response=await env.NOTIFICATION_SOURCE.fetch('https://notifications.internal/eligible');
      if(!response.ok)throw new Error();
      users=await response.json();
    } catch {throw new DeliveryError('NOTIFICATION_ELIGIBILITY_UNAVAILABLE',true);}
    if(!users.some(user=>user.id===userId&&user.categories.includes(category)))throw new DeliveryError('NOTIFICATION_ACCESS_REVOKED');
  }
  if (input.channel === 'webpush') {
    const active = await env.DB.prepare('SELECT id FROM push_subscriptions WHERE id=? AND user_id=? AND endpoint=?')
      .bind(input.subscriptionId, input.userId, input.subscription.endpoint).first();
    if (!active) throw new DeliveryError('PUSH_UNSUBSCRIBED');
    if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) throw new DeliveryError('PUSH_NOT_CONFIGURED');
    const details = webpush.generateRequestDetails(input.subscription, JSON.stringify({ title: input.title, body: input.text,
      url: input.url, tag: input.tag }), { TTL: 3600, vapidDetails: {
      subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } });
    let response: Response;
    try { response = await fetch(details.endpoint, { method: 'POST', headers: details.headers,
      body: new Uint8Array(details.body!), redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DeliveryError('PUSH_TRANSPORT_ERROR', true); }
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=? AND endpoint=?').bind(input.subscriptionId,input.subscription.endpoint).run();
      throw new DeliveryError('PUSH_EXPIRED');
    }
    if (!response.ok) throw new DeliveryError(`PUSH_${response.status}`, response.status === 429 || response.status >= 500,
      false, Number(response.headers.get('retry-after')) || 0);
    return key;
  }
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
