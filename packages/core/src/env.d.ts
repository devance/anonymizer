// Core runs in Workers, Node and the browser; these are the web globals it uses.
declare const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: {
    importKey(format: 'raw', keyData: ArrayBuffer, algorithm: 'AES-GCM', extractable: boolean, usages: string[]): Promise<CryptoKey>;
    encrypt(algorithm: { name: 'AES-GCM'; iv: ArrayBuffer; additionalData?: ArrayBuffer }, key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer>;
    decrypt(algorithm: { name: 'AES-GCM'; iv: ArrayBuffer; additionalData?: ArrayBuffer }, key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface CryptoKey {}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
declare function btoa(data: string): string;
declare function atob(data: string): string;
