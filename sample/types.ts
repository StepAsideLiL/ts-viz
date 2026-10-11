export enum OrderStatus {
  Pending = "pending",
  Paid = "paid",
  Shipped = "shipped",
  Cancelled = "cancelled",
}

export interface Product {
  id: string;
  name: string;
  price: number;
  tags: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  vip?: boolean;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
  currency: "USD" | "EUR" | "GBP";
}

export type Currency = "USD" | "EUR" | "GBP";
