import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';
import { cashActivation, cashPlanLabel, extractActivationCode, isValidCashEmail, normalizeCashEmail } from './activation.js';
import { cashReports } from './reports.js';
import { cashService } from './service.js';
import { formatBrazilDate } from './time.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function looksLikeName(value: string): boolean {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80 || /\d/.test(clean)) return false;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'´` -]+$/.test(clean)) return false;
  return !/^(oi|ola|olá|quero começar|quero comecar|ajuda|menu|saldo|resumo|historico|histórico)$/i.test(clean);
}

function cleanName(value: string): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

async function onboarding(companyId: string) {
  const result = await db.query<{
    owner_name: string | null;
    owner_email: string | null;
    onboarding_state: string | null;
  }>(
    `select owner_name,owner_email,onboarding_state
     from cash_settings where company_id=$1 limit 1`,
    [companyId]
  );
  return result.rows[0] ?? { owner_name: null, owner_email: null, onboarding_state: 'active' };
}

async function saveName(companyId: string, name: string): Promise<void> {
  await db.query(
    `update cash_settings set owner_name=$2,onboarding_state='awaiting_email',updated_at=now()
     where company_id=$1`,
    [companyId, cleanName(name)]
  );
}

async function saveEmailAndComplete(companyId: string, email: string): Promise<void> {
  const normalized = normalizeCashEmail(email);
  if (!isValidCashEmail(normalized)) throw new Error('CASH_EMAIL_INVALID');

  const duplicate = await db.query(
    `select 1 from cash_settings
     where company_id<>$1 and lower(coalesce(owner_email,''))=$2
     limit 1`,
    [companyId, normalized]
  );
  if (duplicate.rowCount) throw new Error('CASH_EMAIL_ALREADY_REGISTERED');

  await db.query('begin');
  try {
    await db.query(
      `update cash_settings set
         owner_email=$2,onboarding_state='active',onboarding_completed_at=now(),updated_at=now()
       where company_id=$1`,
      [companyId, normalized]
    );
    await db.query(
      `update company_verticals set onboarding_completed=true,updated_at=now()
       where company_id=$1 and vertical_id='cash'`,
      [companyId]
    );
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

function activationError(error: unknown): VerticalResult {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'CASH_ACTIVATION_CODE_USED') {
    return text('Esse código já foi utilizado ✅ Se sua conta não estiver ativa, mande “planos” para conferir a assinatura.');
  }
  if (message === 'CASH_ACTIVATION_CODE_EXPIRED') {
    return text('Esse código de ativação expirou. Ele é válido por 24 horas e só pode ser usado uma vez. Se o pagamento foi aprovado, peça um novo código pelo suporte de cobrança.');
  }
  if (message === 'CASH_ACTIVATION_CODE_ACCOUNT_MISMATCH' || message === 'CASH_ACTIVATION_CODE_PHONE_MISMATCH') {
    return text('Esse código pertence a outra conta/WhatsApp e não pode ser usado aqui.');
  }
  return text('Não reconheci esse código de ativação. Confira os caracteres e envie exatamente como recebeu no WhatsApp.');
}

function appendActivationHint(result: VerticalResult | null): VerticalResult | null {
  if (!result) return result;
  const hasPaymentMenu = result.actions.some(action =>
    action.type === 'text' && /R\$\s*4,99|Planos do Arles Cash|Para reativar, escolha um plano/i.test(action.text)
  );
  if (!hasPaymentMenu) return result;
  return {
    ...result,
    actions: result.actions.map((action, index) => {
      if (action.type !== 'text' || index !== result.actions.length - 1) return action;
      return {
        ...action,
        text: `${action.text}\n\n🔐 Após a confirmação do pagamento, você recebe neste WhatsApp um código único de ativação. Envie o código aqui para liberar o período comprado.`
      };
    })
  };
}

export class CashAccessHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const { company, message, combinedText } = context;
    const state = await onboarding(company.id);

    if (state.onboarding_state === 'welcome') {
      await db.query(
        `update cash_settings set onboarding_state='awaiting_name',updated_at=now()
         where company_id=$1 and onboarding_state='welcome'`,
        [company.id]
      );
      await cashReports.ensureScheduled(company.id);
      return text([
        'Oi! Seja bem-vindo ao Arles Cash 💰',
        'Seu assistente financeiro direto no WhatsApp.',
        'Antes de começar, qual é o seu nome?'
      ].join('\n'));
    }

    if (state.onboarding_state === 'awaiting_name') {
      if (!looksLikeName(combinedText)) {
        return text('Antes de começar, me diz seu nome 😊');
      }
      const name = cleanName(combinedText);
      await saveName(company.id, name);
      return text([
        `Perfeito, ${name}! 😊`,
        'Agora me passa seu melhor e-mail.',
        'Ele será usado para identificar seus pagamentos e recuperar sua assinatura quando necessário.'
      ].join('\n'));
    }

    if (state.onboarding_state === 'awaiting_email') {
      const email = normalizeCashEmail(combinedText);
      if (!isValidCashEmail(email)) {
        return text('Esse e-mail não parece válido 🤔\nMe envie algo como: nome@email.com');
      }
      try {
        await saveEmailAndComplete(company.id, email);
      } catch (error) {
        if (error instanceof Error && error.message === 'CASH_EMAIL_ALREADY_REGISTERED') {
          return text('Esse e-mail já está vinculado a outra conta do Arles Cash. Use outro e-mail ou fale com o suporte para recuperar a conta anterior.');
        }
        throw error;
      }

      await cashReports.ensureScheduled(company.id);
      const access = await cashService.accessState(company.id);
      const name = state.owner_name || 'Você';
      if (!access.hasAccess) {
        return text([
          `Cadastro concluído, ${name}! ✅`,
          'Seu trial iniciado no primeiro contato já encerrou.',
          '',
          cashService.paymentMenu(),
          '',
          '🔐 Depois do pagamento, o código de ativação será enviado para este WhatsApp.'
        ].join('\n'));
      }
      return text([
        `Perfeito, ${name}! 🎉`,
        `E-mail cadastrado: ${email}`,
        'Seu trial gratuito de 7 dias está ativo.',
        'Você pode registrar receitas, despesas e consultar seu saldo aqui mesmo.',
        'Já pode começar! Tente mandar: “Gastei 50 no mercado”'
      ].join('\n'));
    }

    const activationCode = extractActivationCode(combinedText);
    if (activationCode) {
      try {
        const activated = await cashActivation.redeem(company.id, message.phone, activationCode);
        return text([
          '✅ Código validado! Seu Arles Cash está ativo.',
          `📌 Plano: ${cashPlanLabel(activated.planKey)}`,
          `📅 Acesso até ${formatBrazilDate(activated.periodEnd)}.`,
          '',
          'O código foi consumido e não pode ser usado novamente.'
        ].join('\n'));
      } catch (error) {
        return activationError(error);
      }
    }

    return appendActivationHint(await cashBroadHandler.handle(context));
  }
}

export const cashAccessHandler = new CashAccessHandler();
