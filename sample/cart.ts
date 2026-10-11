import type { Cart, CartItem, Product, User } from "./types";
import { addTax, applyDiscount, subtotal } from "./pricing";

export function addItem(cart: Cart, product: Product, quantity: number): CartItem[] {
  const existing = cart.items.find((i) => i.product.id === product.id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ product, quantity });
  }
  return cart.items;
}

export function discountFor(user: User, amount: number): number {
  const percent = user.vip ? 15 : 0;
  return applyDiscount(amount, percent);
}

export function checkout(cart: Cart, user: User, taxRate: number): number {
  const base = subtotal(cart.items);
  const discounted = discountFor(user, base);
  return addTax(discounted, taxRate);
}
