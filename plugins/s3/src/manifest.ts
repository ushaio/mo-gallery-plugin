import type { PluginManifest } from '@mo-gallery/plugin-sdk'

export const manifest: PluginManifest = {
  id: 's3-compatible',
  version: '0.1.2',
  coreApiVersion: '1',
  apiVersion: '1',
  type: 'node',
  runtime: 'node22',
  name: 'S3 Compatible / Cloudflare R2',
  description: 'Upload photos to AWS S3-compatible object storage and Cloudflare R2.',
  entry: 'dist/main.js',
  platforms: ['windows-amd64', 'darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64'],
  capabilities: ['plugin.health', 'source.validate', 'object.put', 'object.get', 'object.stat', 'object.list', 'object.move', 'object.delete', 'object.getUrl', 'checksum', 'idempotency'],
  contributions: [{
    domain: 'storage',
    apiVersion: '1',
    capabilities: ['plugin.health', 'source.validate', 'object.put', 'object.get', 'object.stat', 'object.list', 'object.move', 'object.delete', 'object.getUrl', 'checksum', 'idempotency'],
  }],
  permissions: ['network:configured-endpoint'],
  configSchema: {
    type: 'object',
    properties: {
      endpoint: {
        type: 'string', title: 'Endpoint', description: 'Leave empty for AWS S3.',
        'x-i18n': {
          zh: { title: '服务端点', description: 'R2 填写 https://<account-id>.r2.cloudflarestorage.com；AWS S3 可留空。' },
          en: { title: 'Endpoint', description: 'For R2 use https://<account-id>.r2.cloudflarestorage.com; leave empty for AWS S3.' },
        },
      },
      region: {
        type: 'string', title: 'Region',
        'x-i18n': {
          zh: { title: '区域', description: 'Cloudflare R2 填写 auto；其他 S3 服务填写对应区域。' },
          en: { title: 'Region', description: 'Use auto for Cloudflare R2; use the provider region for other S3 services.' },
        },
      },
      bucket: {
        type: 'string', title: 'Bucket',
        'x-i18n': {
          zh: { title: '存储桶', description: '填写 R2 或 S3 存储桶名称。' },
          en: { title: 'Bucket', description: 'The name of your R2 or S3 bucket.' },
        },
      },
      basePath: {
        type: 'string', title: 'Base path',
        'x-i18n': { zh: { title: '基础路径', description: '可选。所有照片对象都会写入此前缀目录。' }, en: { title: 'Base path', description: 'Optional prefix for all uploaded photo objects.' } },
      },
      publicUrl: {
        type: 'string', title: 'Public URL prefix',
        'x-i18n': { zh: { title: '公开访问地址', description: '可选。填写 R2 自定义域名或公开 Bucket URL；留空则使用端点地址。' }, en: { title: 'Public URL prefix', description: 'Optional public R2 custom domain or bucket URL. Leave empty to use the endpoint.' } },
      },
      forcePathStyle: {
        type: 'string', title: 'Force path style (true/false)',
        'x-i18n': { zh: { title: '强制路径风格（true/false）', description: 'R2 建议保持 true；只有服务商要求虚拟主机风格时填写 false。' }, en: { title: 'Force path style (true/false)', description: 'Keep true for R2; use false only when the provider requires virtual-hosted style.' } },
      },
      urlMode: {
        type: 'string', title: 'URL mode (public/signed)',
        'x-i18n': { zh: { title: '访问地址模式（public/signed）', description: '有公开域名时使用 public；私有 Bucket 使用 signed。' }, en: { title: 'URL mode (public/signed)', description: 'Use public with a public domain; use signed for a private bucket.' } },
      },
      signedUrlExpiresSeconds: {
        type: 'string', title: 'Signed URL lifetime (seconds)',
        'x-i18n': { zh: { title: '签名地址有效期（秒）', description: '仅 signed 模式生效，范围 60–86400，默认 900。' }, en: { title: 'Signed URL lifetime (seconds)', description: 'Only for signed mode. Allowed range is 60–86400; default is 900.' } },
      },
    },
    required: ['region', 'bucket'],
  },
  credentialSchema: {
    type: 'object',
    properties: {
      accessKey: { type: 'string', title: 'Access key', format: 'password', 'x-i18n': { zh: { title: '访问密钥' }, en: { title: 'Access key' } } },
      secretKey: { type: 'string', title: 'Secret key', format: 'password', 'x-i18n': { zh: { title: '秘密密钥' }, en: { title: 'Secret key' } } },
      sessionToken: { type: 'string', title: 'Session token', format: 'password', 'x-i18n': { zh: { title: '会话令牌' }, en: { title: 'Session token' } } },
    },
    required: ['accessKey', 'secretKey'],
  },
}
