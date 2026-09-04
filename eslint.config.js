/*
 * ESLint の設定（フラット設定）。
 *
 * 型チェックは `tsc --noEmit` が build の中で見ているので、ここは型を要求しない
 * ルールだけに絞る。型情報つきのルール（no-floating-promises など）を入れると
 * lint に数十秒かかるようになるので、速さのほうを取っている。
 *
 * Prettier は入れていない。整形の差分でファイル全体が書き換わると、
 * 「誰が何を変えたか」が追えなくなるため。
 */

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Deno で動く Edge Function は対象外（拡張子つき import が解決できない）。
    // 中身は `supabase/functions/` 側の作法に従う
    ignores: ['dist/', 'node_modules/', 'supabase/', 'playwright-report/', 'test-results/'],
  },

  // ---- ブラウザで動くアプリ本体 ----
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 使わない引数は _ で始める（tsconfig の noUnusedParameters と揃える）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // 日本語の文面には全角スペースが入る。文字列・コメント・テンプレートの
      // 中は素通しにして、コードの隙間に紛れ込んだものだけを咎める
      'no-irregular-whitespace': ['error', { skipTemplates: true, skipComments: true }],
    },
  },

  // ---- プッシュ通知の Service Worker（唯一の素の JS）----
  {
    files: ['public/sw.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
  },

  // ---- Node で動く設定ファイル ----
  {
    files: ['*.config.{js,ts}', 'vitest.workspace.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
)
