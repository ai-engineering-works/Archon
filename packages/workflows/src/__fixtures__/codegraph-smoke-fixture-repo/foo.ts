import { bar } from './bar';

export function foo(): string {
  return bar() + '_foo';
}
