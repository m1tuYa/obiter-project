import { defineConfig } from 'vite';

// 開発中(npm run dev)もローカルサーバのAPIへ届くように中継する
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:4870',
    },
  },
});
