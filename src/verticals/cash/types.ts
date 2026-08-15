export type CashTransactionType = 'income' | 'expense';

export interface CashTransactionInput {
  type: CashTransactionType;
  amount: number;
  category: string;
  merchant: string;
  description: string;
  transactionDate: string;
}

export interface CashSummary {
  income: number;
  expense: number;
  balance: number;
  count: number;
  categories: Array<{ category: string; amount: number }>;
}

