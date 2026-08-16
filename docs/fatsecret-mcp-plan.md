# fatsecret-mcp 新規構築 計画

fitness-mcp（Hevy専用化）と並行して進める、FatSecret専用の新規MCPサーバー。
「製品ごとにMCPを分ける」方針に沿い、**別リポジトリ**として新規作成する（例: `fatsecret-mcp`）。

参考: リポジトリ名の一貫性という観点では、既存の `fitness-mcp` も将来的に `hevy-mcp` へ改名した方が「製品名=リポジトリ名」の原則と揃う。これは必須ではないので、気になるようであれば別途検討。

## 0. 前提・確定事項

- 用途: 食品データベース検索・栄養情報参照 **に加えて**、自分の食事日記・体重記録の読み書きも行う
- FatSecret APIの利用登録はこれから（Claude Codeでは代行できない。人間側の作業が必要）
- アーキテクチャは fitness-mcp と同じパターンを踏襲: Next.js on Vercel + 独自OAuth2.1（Claude向け）のリモートMCP
- 個人デプロイ前提（マルチテナントにしない）は fitness-mcp と同様
- 書き込み系ツールは fitness-mcp と同じ安全設計: `confirm: boolean`パラメータ＋スキル側での確認フロー運用

## 1. FatSecret APIの認証構造（重要・fitness-mcpとの最大の違い）

FatSecretは**2種類の認証**が混在しており、この設計がツール実装を分岐させる：

| 種別 | 対象メソッド例 | 認証方式 |
|---|---|---|
| Signed Request（ユーザー非依存） | `foods.search`, `food.get`, `recipe.get`, `recipes.search` | OAuth2.0 Client Credentials（Client ID/Secret）で完結。ユーザー認可不要 |
| Signed & Delegated Request（ユーザー依存） | `food_entry.create/edit/delete`, `weights.get_month`, `weight.update`, `exercise_entries.*`, `profile.get`, `foods.get_favorites`等 | **OAuth1.0の3-legged認証のみ対応**（OAuth2.0では不可）。ユーザーごとのAccess Token/Secretが必要 |

つまりこのMCPサーバー内には認証レイヤーが2つ入れ子になる：

1. **Claude ⇔ 本MCPサーバー**: 既存の独自OAuth2.1 + Bearer（fitness-mcpと同じ実装を流用可）
2. **本MCPサーバー ⇔ FatSecret API**:
   - 食品/レシピ検索系: OAuth2.0 Client Credentials（トークンをサーバー側でキャッシュ・自動更新するだけ、ユーザー操作不要）
   - 日記/体重系: OAuth1.0 3-legged（**一度だけ**人間がブラウザでFatSecretにログインして認可する必要あり。得られたAccess Token/Secretを環境変数に保存し、以後は自動でHMAC-SHA1署名して使い回す）

## 2. 事前準備（人間側のタスク・Claude Codeでは実行不可）

Claude Codeに着手を依頼する前に、以下は使う本人が行う：

1. FatSecret Platform APIに開発者登録し、Client ID/Secret（OAuth2.0用）とConsumer Key/Secret（OAuth1.0用）を取得
2. 体重日記（`weights.get_month.v2`等）はPremier限定機能の可能性が高いので、必要なスコープ（basic / premier等）が自分のプランに含まれるか登録時に確認する

これらが揃ってから実装フェーズを開始する。

## 3. Phase 1: 土台（fitness-mcpからの流用）

- fitness-mcpの `lib/auth.ts` / `lib/oauth.ts`（Claude向け独自OAuth2.1実装）をベースに、新リポジトリの土台としてコピー・移植する
- `derive`スクリプトによる3秘密鍵生成の仕組みもそのまま踏襲
- CI構成（3層テスト: unit/integration/e2e）も同じ方針で用意する

## 4. Phase 2: 食品・レシピ検索（Signed Requestのみ、読み取り専用）

ユーザー認可不要で先に実装できる部分。ここから着手するのが安全かつ早い。

- `search_foods`（foods.search）
- `get_food_detail`（food.get 最新バージョン）
- `search_recipes`（recipes.search）
- `get_recipe_detail`（recipe.get）
- `find_food_by_barcode`（food.find_id_for_barcode。Premier限定の可能性があるため要確認）

サーバー側でOAuth2.0 Client Credentialsのアクセストークンを取得・キャッシュし、期限切れ時は自動リフレッシュする仕組みを`lib/fatsecret/appAuth.ts`（仮）として実装する。

## 5. Phase 3: 3-legged OAuth1.0 セットアップ

日記・体重系機能の前提として、一度だけの認可フローを実装する。

- 一回限りのセットアップ用スクリプト（`scripts/fatsecret-oauth-setup.ts`想定）を用意し、以下を行う:
  1. Request Token取得
  2. 認可URLを表示 → 本人がブラウザでFatSecretにログインして認可
  3. verifierを入力してAccess Token/Secretを取得
  4. 取得したAccess Token/Secretを`.env.local`に書き出す（`FATSECRET_ACCESS_TOKEN` / `FATSECRET_ACCESS_TOKEN_SECRET`）
- 本番運用ではこのAccess Token/Secretは失効しない前提（FatSecretの仕様次第。失効する場合は再実行の手順をREADMEに明記する）

参考実装（認証フローのみ。コード流用はせず設計の参考に留める）: `fcoury/fatsecret-mcp`（MCPツールとしてOAuthフローを露出する設計）。本プロジェクトは個人単一ユーザー前提のため、MCPツールとしてではなく**セットアップスクリプト**として一度だけ実行する設計にする。

## 6. Phase 4: 日記・体重・エクササイズ記録（3-legged必須）

**読み取り系**
- `get_food_diary`（食事日記の日別取得）
- `get_favorite_foods` / `get_most_eaten_foods` / `get_recently_eaten_foods`
- `get_weight_history`（Premier限定の可能性）
- `get_exercise_diary`
- `get_profile`

**書き込み系（すべて`confirm: boolean = false`必須、fitness-mcpと同じdry-run設計）**
- `create_food_diary_entry`
- `update_food_diary_entry`
- `delete_food_diary_entry`
- `update_weight`
- `create_exercise_entry`

## 7. Phase 5: OSS整備

- README: 認証構造が複雑なため、「なぜ2種類のOAuthが混在するのか」を図解レベルで説明するセクションを用意する
- セットアップ手順に「FatSecret開発者登録 → 3-legged認可スクリプト実行 → Vercelデプロイ」の順序を明記
- CONTRIBUTING.md、MITライセンス、CI整備はfitness-mcpと同水準

## 8. 進め方の推奨順序

1. （人間側）FatSecret API登録・スコープ確認
2. Phase 1（土台）
3. Phase 2（食品検索、読み取りのみ、認可不要）← ここまでで最小限動くものが完成
4. Phase 3（3-legged認可スクリプト）
5. Phase 4（日記・体重・エクササイズ）
6. Phase 5（OSS整備）

## 9. Claude Codeに渡す際の一言

「FatSecret API登録がまだの場合、Phase 2（食品検索）はダミーのClient ID/Secretでも実装・テスト（モック）までは進められます。Phase 3以降は実際のAPI登録完了後に着手してください」と伝えることを推奨。

## 補足: このドキュメントについて

このファイルは `fitness-mcp` リポジトリ内に置かれているが、計画自体は **新規・別リポジトリ**（`fatsecret-mcp`）の構築を対象にしている。fitness-mcp のコード自体への変更はまだ含まない。理由:

- Phase 0の前提（FatSecret API開発者登録・Client ID/Secret・Consumer Key/Secretの取得）が未完了で、人間側の作業待ちであるため、実装（Phase 1以降）にまだ着手できない。
- 新規リポジトリの作成は、このセッションのGitHubアクセスが `ikeike443/fitness-mcp` にスコープされているため、別途リポジトリ作成の許可を得てから行う。

前提が整い次第、以下のいずれかの進め方を想定している:

1. `fatsecret-mcp` という新規リポジトリを作成し、Phase 1（fitness-mcpの `lib/auth.ts` / `lib/oauth.ts` を土台として移植）から着手する。
2. Phase 2（食品・レシピ検索、読み取り専用、ユーザー認可不要）はダミーのClient ID/Secretでもモックテストまで実装を進められる。
