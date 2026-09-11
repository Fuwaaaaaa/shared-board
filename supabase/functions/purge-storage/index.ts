/*
 * Supabase Edge Function の入口。
 *
 * 中身が handler.ts に分けてあるのは、テストのため。Deno.serve をモジュールの
 * 一番上で呼んでいると、テストが import した時点でポートを掴んでしまう。
 * 入口をこの 1 行に切り離しておけば、handler.ts はただの関数として呼べる。
 * 本番で走るものは変わらない（Supabase はこの index.ts を入口として束ねる）。
 */

import { handler } from './handler.ts'

Deno.serve(handler)
