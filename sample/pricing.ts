import type { CartItem } from "./types";

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function lineTotal(item: CartItem): number {
  return round2(item.product.price * item.quantity);
}

export function subtotal(items: CartItem[]): number {
  return round2(items.reduce((sum, item) => sum + lineTotal(item), 0));
}

export function applyDiscount(amount: number, percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return round2(amount * (1 - clamped / 100));
}

export function addTax(amount: number, rate: number): number {
  return round2(amount * (1 + rate));
}
