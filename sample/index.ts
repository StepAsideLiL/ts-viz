import type { Cart, Product, User } from "./types";
import { addItem, checkout } from "./cart";
import { lineTotal } from "./pricing";

export function createUser(name: string, email: string, vip: boolean): User {
  return { id: "u_" + Math.random().toString(36).slice(2, 8), name, email, vip };
}

export function makeProduct(id: string, name: string, price: number, tags: string[]): Product {
  return { id, name, price, tags };
}

export function main(): number {
  const user = createUser("Ada Lovelace", "ada@example.com", true);
  const cart: Cart = { items: [], currency: "USD" };

  const keyboard = makeProduct("sku-1", "Mechanical Keyboard", 129.99, ["hardware", "input"]);
  const mouse = makeProduct("sku-2", "Wireless Mouse", 59.5, ["hardware"]);

  addItem(cart, keyboard, 1);
  addItem(cart, mouse, 2);

  const total = checkout(cart, user, 0.19);
  console.log("first line total:", lineTotal(cart.items[0]));
  console.log("cart total:", total);
  return total;
}

main();
