/**
 * 哈希工具。扫描器与归档器共用，避免两处各写一份流式读取。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * 流式计算文件 sha256。
 *
 * 不整文件读进内存：会话文件可能几十 MB，一次性读入既慢又占内存。
 * @param {string} abs
 * @returns {Promise<string>} 小写十六进制
 */
export function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(abs);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 字符串的 sha256（用于校验清单本身）。 */
export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
