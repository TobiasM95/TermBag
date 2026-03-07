import type { TermBagApi } from "../shared/types";

declare global {
  interface Window {
    termbag: TermBagApi;
  }
}

export {};
