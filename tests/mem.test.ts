import { describe, expect, it } from 'vitest';
import { parseHexText } from '../src/core/mem';

const bytes = (s: string) => [...parseHexText(s).bytes];

describe('parseHexText: 纯 HEX', () => {
  it('空白分隔字节', () => {
    expect(bytes('de ad be ef')).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('连续偶数位 HEX', () => {
    expect(bytes('deadbeef')).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('多个偶数位标记拼成完整字节', () => {
    expect(bytes('01 0203')).toEqual([0x01, 0x02, 0x03]);
  });

  it('0x 前缀只接受 1–2 位', () => {
    expect(bytes('0xde 0xAD 0x1')).toEqual([0xde, 0xad, 0x01]);
    expect(parseHexText('0x100').error).toContain('1–2 位');
  });

  it('奇数位不静默吞掉', () => {
    const r = parseHexText('aa bb c');
    expect(r.error).toContain('第 1 行');
    expect(r.error).toContain('奇数');
    expect(r.bytes.length).toBe(0);
  });

  it('无法识别的文本报错而不是猜', () => {
    expect(parseHexText('hello').error).toContain('无法识别');
  });
});

describe('parseHexText: hexdump -C', () => {
  it('末尾地址行不是数据', () => {
    const text = '00000000  01 02 03 04  |....|\n00000004\n';
    expect(bytes(text)).toEqual([1, 2, 3, 4]);
  });

  it('忽略 ASCII 栏并校验地址连续性', () => {
    const text = [
      '00000000  01 02 03 04 05 06 07 08  |........|',
      '00000008  09 0a  |..|',
    ].join('\n');
    expect(bytes(text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('地址跳跃报错', () => {
    const text = '00000000  01 02\n00000010  03 04\n';
    expect(parseHexText(text).error).toContain('不连续');
  });

  it('地址倒退报错', () => {
    const text = '00000010  01 02\n00000000  03 04\n';
    expect(parseHexText(text).error).toContain('不连续');
  });

  it('末尾地址与已读长度不符时报错', () => {
    const text = '00000000  01 02\n00000008\n';
    expect(parseHexText(text).error).toContain('末尾地址');
  });

  it('* 压缩行明确拒绝', () => {
    const text = '00000000  01 02\n*\n';
    expect(parseHexText(text).error).toContain('* 压缩行');
  });

  it('数据列里的非字节内容报错', () => {
    const text = '00000000  01 0203\n';
    expect(parseHexText(text).error).toContain('无法识别');
  });

  it('xxd 的 ASCII 栏不当作数据', () => {
    const text = '00000000: 01 02 03 04  ....\n';
    expect(bytes(text)).toEqual([1, 2, 3, 4]);
  });
});
