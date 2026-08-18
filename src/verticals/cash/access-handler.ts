import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashAiFirstHandler } from './ai-first-handler.js';
import { cashPaymentMenuForCompany } from './checkout.js';
import { cashConversationHandler } from './conversation.js';
import { handleCashConversationSafety } from './conversation-safety.js';
import { handleCashDeterministicLanguage } from './deterministic-language.js';
import { handleCashBulkDeletionCommand, isCashDeletionCommand } from './deletion.js';
import { fastCashFaq } from './fast-faq.js';
import { handleCashLedgerDeterministic } from './ledger.js';
import { handleCashPocketContextCommand } from './pocket-context.js';
import { normalizeCashPocketLanguage } from './pocket-language.js';
import { handleCashPocketOrganization } from './pocket-organization.js';
import { handleCashPocketReceivable } from './pocket-receivables.js';
import { handleCashPocketTransfer } from './pocket-transfer.js';
import { cashReports } from './reports.js';
import { handleCashScheduleDeterministic } from './schedules.js';
import { cashService } from './service.js';
import { handleCashSnapshotSafety } from './snapshot-safety.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function cleanName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function nameKey(value: string): string {
  return cleanName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function looksLikeName(value: string): boolean {
  const clean = cleanName(value);
  if (clean.length < 2 || clean.length > 80 || /\d/.test(clean)) return false;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'´` -]+$/.test(clean)) return false;
  if (clean.split(/\s+/).length > 6) return false;
  return !/^(oi|ola|olá|oii+|quero começar|quero comecar|ajuda|menu|saldo|resumo|historico|histórico|certo|ok|okay|beleza|entendi|obrigado|obrigada|valeu|tudo bem|sim|não|nao)$/i.test(clean);
}

export function extractCashOnboardingName(value: string): string | null {
  const lines = String(value ?? '')
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  const candidates: Array<{ name: string; explicit: boolean }> = [];
  for (const line of lines) {
    const explicitMatch = line.match(/^(?:meu nome\s+(?:é|e)|eu sou|sou|me chamo)\s+(.+)$/i);
    const candidate = cleanName(explicitMatch?.[1] ?? line);
    if (!looksLikeName(candidate)) continue;
    candidates.push({ name: candidate, explicit: Boolean(explicitMatch) });
  }

  if (!candidates.length) return null;

  const unique = new Map<string, { name: string; explicit: boolean }>();
  for (const candidate of candidates) {
    const key = nameKey(candidate.name);
    const current = unique.get(key);
    if (!current || candidate.explicit) unique.set(key, candidate);
  }

  if (unique.size === 1) return [...unique.values()][0]!.name;

  const explicit = [...unique.values()].filter(candidate => candidate.explicit);
  if (explicit.length === 1) return explicit[0]!.name;
  return null;
}

function normalizeEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase().slice(0, 254);
}

function isValidEmail(value: string): boolean {
  const email = normalizeEmail(value);
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email));
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
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new Error('CASH_EMAIL_INVALID');

  const client = await db.connect();
  try {
    await client.query('begin');
    const duplicate = await client.query(
      `select 1 from cash_settings
       where company_id<>$1 and lower(coalesce(owner_email,''))=$2
       limit 1`,
      [companyId, normalized]
    );
    if (duplicate.rowCount) throw new Error('CASH_EMAIL_ALREADY_REGISTERED');

    await client.query(
      `update cash_settings set
         owner_email=$2,onboarding_state='active',onboarding_completed_at=now(),updated_at=now()
       where company_id=$1`,
      [companyId, normalized]
    );
    await client.query(
      `update company_verticals set onboarding_completed=true,updated_at=now()
       where company_id=$1 and vertical_id='cash'`,
      [companyId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function personalizePaymentMenu(companyId: string, result: VerticalResult | null): Promise<VerticalResult | null> {
  if (!result) return result;
  const staticMenu = cashService.paymentMenu();
  if (!result.actions.some(action => action.type === 'text' && action.text.includes(staticMenu))) return result;

  const personalized = await cashPaymentMenuForCompany(companyId);
  return {
    ...result,
    actions: result.actions.map(action => action.type === 'text'
      ? { ...action, text: action.text.replace(staticMenu, personalized) }
      : action)
  };
}

export class CashAccessHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const { company, combinedText } = context;
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
      const name = extractCashOnboardingName(combinedText);
      if (!name) return text('Antes de começar, me diz seu nome 😊');
      await saveName(company.id, name);
      return text([
        `Perfeito, ${name}! 😊`,
        'Agora me passa seu melhor e-mail.',
        'Ele serve para identificar sua compra e recuperar sua assinatura se for necessário.'
      ].join('\n'));
    }

    if (state.onboarding_state === 'awaiting_email') {
      const email = normalizeEmail(combinedText);
      if (!isValidEmail(email)) {
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
          'Escolha um plano para reativar:',
          '',
          await cashPaymentMenuForCompany(company.id),
          '',
          'Assim que o pagamento for confirmado, seu acesso é liberado automaticamente aqui no WhatsApp.'
        ].join('\n'));
      }

      return text([
        `Perfeito, ${name}! 🎉`,
        `E-mail cadastrado: ${email}`,
        'Seu trial gratuito de 7 dias está ativo.',
        'Você pode registrar receitas, despesas, criar cofrinhos e consultar seu saldo aqui mesmo.',
        'Já pode começar! Tente mandar: “Gastei 50 no mercado”'
      ].join('\n'));
    }

    if (state.onboarding_state === 'active' && !state.owner_email) {
      await db.query(
        `update cash_settings set onboarding_state='awaiting_email',updated_at=now() where company_id=$1`,
        [company.id]
      );
      return text('Antes de continuar, me passa seu melhor e-mail 😊\nEle será usado para identificar e recuperar seus pagamentos quando necessário.');
    }

    // Cofre, caixinha, envelope, potinho e erros comuns de digitação passam a usar a
    // mesma gramática interna de cofrinho antes de qualquer roteamento financeiro.
    context.combinedText = normalizeCashPocketLanguage(context.combinedText);

    // Nova barreira central: corrige linguagem quebrada, usa contexto curto com segurança,
    // separa lançamento + consulta e bloqueia referências destrutivas ambíguas.
    const conversationSafety = await handleCashConversationSafety(context);
    if (conversationSafety) return conversationSafety;

    // “Falta cobrar / tenho a receber / me deve” é estado financeiro, não receita real.
    // Mantemos a pendência ligada ao cofrinho até o dinheiro efetivamente entrar.
    const pocketReceivable = await handleCashPocketReceivable(context);
    if (pocketReceivable) return pocketReceivable;

    // Agenda/previsão vem antes da movimentação imediata de cofrinhos. Isso garante que
    // “todo dia 10 gasto 300 no cofrinho Cartão” continue sendo previsão.
    const scheduled = await handleCashScheduleDeterministic(context);
    if (scheduled) return scheduled;

    // Guardar/retirar dinheiro de cofrinho é uma alocação interna: muda o disponível
    // fora dos cofrinhos, mas não cria receita/despesa falsa nem altera o saldo total.
    const pocketTransfer = await handleCashPocketTransfer(context);
    if (pocketTransfer) return pocketTransfer;

    // Pedidos naturais de organização como “registre os gastos deste mês no cofrinho X”
    // precisam acontecer antes do parser genérico de cofrinhos e de consultas.
    const pocketOrganization = await handleCashPocketOrganization(context);
    if (pocketOrganization) return pocketOrganization;

    // Mensagens que misturam total vendido, caixa, retiradas e valores a receber não
    // podem virar um lote de despesas por semelhança textual.
    const snapshotSafety = await handleCashSnapshotSafety(context);
    if (snapshotSafety) return snapshotSafety;

    // Administração e contexto de cofrinhos vêm antes da exclusão de registros. Assim,
    // depois de “quais cofrinhos eu tenho?”, “apaga ele” não pode apagar uma transação.
    const pocketCommand = await handleCashPocketContextCommand(context);
    if (pocketCommand) return pocketCommand;

    // Formas naturais muito comuns são reescritas/delegadas para motores seguros antes
    // do GPT. Essa camada não calcula nem grava sozinha; só evita fallback de IA desnecessário.
    const deterministicLanguage = await handleCashDeterministicLanguage(context);
    if (deterministicLanguage) return deterministicLanguage;

    // Saldo e simulações são operações de leitura/cálculo. Nunca criam lançamento e
    // são resolvidas 100% por script + banco antes de qualquer chamada de IA.
    const ledger = await handleCashLedgerDeterministic(context);
    if (ledger) return ledger;

    if (isCashDeletionCommand(context.combinedText)) {
      const bulk = await handleCashBulkDeletionCommand(context);
      if (bulk) return bulk;
      return await personalizePaymentMenu(company.id, await cashConversationHandler.handle(context));
    }

    const fastFaq = await fastCashFaq(context);
    if (fastFaq) return fastFaq;

    // O GPT só entra depois de agenda, organização/cofrinhos, linguagem determinística,
    // saldo, simulação, exclusões, FAQ e do corpus interno do AiFirstHandler.
    return await personalizePaymentMenu(company.id, await cashAiFirstHandler.handle(context));
  }
}

export const cashAccessHandler = new CashAccessHandler();
