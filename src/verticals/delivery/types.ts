export type DeliveryState =
  | 'idle'
  | 'waiting_name'
  | 'waiting_delivery_type'
  | 'waiting_address'
  | 'waiting_payment'
  | 'waiting_change'
  | 'waiting_confirmation';

export type DeliveryType = '' | 'delivery' | 'pickup';
export type PaymentMethod = '' | 'pix' | 'cash' | 'card';

export interface DeliveryProduct {
  id: string;
  name: string;
  category: string;
  description: string;
  price: number;
}

export interface DeliveryItem {
  product_id: string;
  name: string;
  quantity: number;
  variation: string;
  unit_price: number;
  notes: string;
}

export interface DeliveryDraft {
  client_name: string;
  items: DeliveryItem[];
  observations: string;
  delivery_type: DeliveryType;
  delivery_address: string;
  payment_method: PaymentMethod;
  change_for: number | null;
  delivery_fee: number | null;
}

export interface DeliveryStore {
  company_id: string;
  store_name: string;
  short_description: string | null;
  avg_time: string | null;
  min_order: number | null;
  opening_hours: string | null;
  delivery_fee: string | null;
  neighborhoods: string | null;
  payment_methods: string | null;
  pix_key: string | null;
  ai_rules: string | null;
}

export interface DeliveryCustomer {
  id: string;
  name: string;
  phone_number: string;
  default_address: string | null;
  favorite_payment: string | null;
}
