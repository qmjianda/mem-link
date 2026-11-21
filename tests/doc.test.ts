import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../src/bp/doc';

const CHUNK = 3 * 8192;

describe('base64 编解码', () => {
  it('已知向量', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(bytesToBase64(Uint8Array.of(0x66))).toBe('Zg==');
    expect(bytesToBase64(Uint8Array.of(0x66, 0x6f))).toBe('Zm8=');
    expect(bytesToBase64(Uint8Array.of(0x66, 0x6f, 0x6f))).toBe('Zm9v');
    expect(bytesToBase64(Uint8Array.from([0, 1, 2, 0x7f, 0x80, 0xff]))).toBe('AAECf4D/');
  });

  it('分块边界前后与全字节范围往返一致', () => {
    const samples = [
      new Uint8Array(CHUNK - 1),
      new Uint8Array(CHUNK),
      new Uint8Array(CHUNK + 1),
      new Uint8Array(CHUNK + 2),
      Uint8Array.from({ length: 256 }, (_, i) => i),
    ];
    samples.forEach((bytes, i) => {
      bytes.forEach((_, j) => { bytes[j] = (j * 31 + i * 7) & 0xff; });
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    });
  });
});
