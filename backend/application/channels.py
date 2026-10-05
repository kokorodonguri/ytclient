"""収集対象の定義。

チャンネル一覧はビジネス上の設定であり、収集ロジックとは変更理由が違う。
メンバーの増減でロジック側のファイルを触らずに済むよう分離する。
"""

TARGET_CHANNELS = [
    # --- ぶいすぽっ！ (JP) ---
    "https://www.youtube.com/@KagaSumire",                     # 花芽すみれ
    "https://www.youtube.com/@nazunakaga",                     # 花芽なずな
    "https://www.youtube.com/@totokogara",                     # 小雀とと
    "https://www.youtube.com/@uruhaichinose",                  # 一ノ瀬うるは
    "https://www.youtube.com/@963Noah",                        # 胡桃のあ
    "https://www.youtube.com/@hinanotachiba7",                 # 橘ひなの
    "https://www.youtube.com/@ren_kisaragi__",                 # 如月れん
    "https://www.youtube.com/@tosakimimi3369",                 # 兎咲ミミ
    "https://www.youtube.com/@asumi_sena",                     # 空澄セナ
    "https://www.youtube.com/@lisahanabusa",                   # 英リサ
    "https://www.youtube.com/@KaminariQpi",                    # 神成きゅぴ
    "https://www.youtube.com/channel/UCjXBuHmWkieBApgBhDuJMMQ", # 八雲べに
    "https://www.youtube.com/@AizawaEma",                      # 藍沢エマ
    "https://www.youtube.com/@shinomiyaruna",                  # 紫宮るな
    "https://www.youtube.com/@tsuna_nekota",                   # 猫汰つな
    "https://www.youtube.com/@shiranamiramune",                # 白波らむね
    "https://www.youtube.com/@Met_Komori",                     # 小森めと
    "https://www.youtube.com/@akarindao",                      # 夢野あかり
    "https://www.youtube.com/@YanoKuromu",                     # 夜乃くろむ
    "https://www.youtube.com/@Kokage_Tsumugi",                 # 紡木こかげ
    "https://www.youtube.com/@SendoYuuhi",                     # 千燈ゆうひ
    "https://www.youtube.com/@HanabiChoya",                    # 蝶屋はなび
    "https://www.youtube.com/@Moka_Amayui",                    # 甘結もか
    "https://www.youtube.com/@Saine_Ginjo",                    # 銀城サイネ
    "https://www.youtube.com/@Chise_Tatsumaki",                # 龍巻ちせ

    # --- VSPO! EN ---
    "https://www.youtube.com/@RemiaAotsuki",                   # Remia Aotsuki
    "https://www.youtube.com/@AryaKuroha",                     # Arya Kuroha
    "https://www.youtube.com/@jirajisaki",                     # Jira Jisaki
    "https://www.youtube.com/@narinmikure",                    # Narin Mikure
    "https://www.youtube.com/@rikosolari",                     # Riko Solari
    "https://www.youtube.com/@erissuzukami",                   # Eris Suzukami
    "https://www.youtube.com/@JunoUmezono",                    # Juno Umezono

    # --- 公式チャンネル ---
    "https://www.youtube.com/@Vspo77",                         # ぶいすぽっ！公式
    "https://www.youtube.com/@VSPO-EN",                        # VSPO! EN Official
]

CLIP_QUERIES = ["ぶいすぽ 切り抜き", "VSPO 切り抜き"]
