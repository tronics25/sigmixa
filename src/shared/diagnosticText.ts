/** Presentation-only translations of built-in diagnostics. Keep codes and stored diagnostic messages unchanged. */
const translations: readonly (readonly [string, string])[] = [
  ["Frame ID is required.", "フレームIDを入力してください。"],
  ["Frame name is required.", "フレーム名を入力してください。"],
  ["CAN ID must fit the {0}-bit range.", "CAN IDは{0}ビットの範囲で入力してください。"],
  ["Frame length must be a valid Classic CAN or CAN FD payload length.", "フレーム長にはClassic CANまたはCAN FDで有効な長さを指定してください。"],
  ["Expected period must be a positive finite number of milliseconds.", "期待周期には0より大きい有限の値をミリ秒で指定してください。"],
  ["A multiplexed Frame must have exactly one Multiplexer Signal.", "Multiplexingを使うフレームにはMultiplexerを1つ指定してください。"],
  ["Signal multiplexing requires Multiplexing to be enabled for the Frame.", "フレームのMultiplexingを有効にしてください。"],
  ["Signal ID is required.", "シグナルIDを入力してください。"],
  ["Signal name is required.", "シグナル名を入力してください。"],
  ["Signal ID “{0}” is duplicated.", "シグナルID「{0}」が重複しています。"],
  ["Signal name “{0}” is duplicated in this Frame.", "このフレーム内でシグナル名「{0}」が重複しています。"],
  ["value labels require decimal or hexadecimal (0x…) RAW integers and text labels.", "値ラベルには10進数または16進数（0x…）のRAW整数値と文字列を指定してください。"],
  ["duplicate RAW value {0}.", "RAW値{0}が重複しています。"],
  ["RAW value {0} is outside the Signal bit range.", "RAW値{0}がシグナルのビット範囲を超えています。"],
  ["byte position must be a non-negative integer.", "BYTEには0以上の整数を指定してください。"],
  ["bit position must be between 0 and 7.", "BITには0〜7の整数を指定してください。"],
  ["length must be between 1 and 64 bits.", "LENGTHには1〜64ビットの整数を指定してください。"],
  ["bit range exceeds the frame length.", "ビット範囲がフレーム長を超えています。"],
  ["Multiplexer must be an unsigned Signal of 1 to 32 bits.", "Multiplexerは符号なしの1〜32ビットのシグナルにしてください。"],
  ["ACTIVE WHEN requires at least one value.", "ACTIVE WHENには1つ以上の値を指定してください。"],
  ["ACTIVE WHEN range is outside the Multiplexer value range.", "ACTIVE WHENがMultiplexerの値の範囲を超えています。"],
  ["{0} overlaps another signal at byte {1}, bit {2}.", "{0}はBYTE {1}、BIT {2}で別のシグナルと重複しています。"],
  ["Scale must be a non-zero finite number.", "SCALEには0以外の有限の値を指定してください。"],
  ["Scale is required.", "SCALEを入力してください。"],
  ["Scale denominator must not be zero.", "SCALEの分母には0以外の値を指定してください。"],
  ["Scale must be finite.", "SCALEには有限の値を指定してください。"],
  ["Scale must not be zero.", "SCALEには0以外の値を指定してください。"],
  ["Scale magnitude must be between {0} and {1}.", "SCALEの絶対値は{0}〜{1}の範囲で指定してください。"],
  ["stored Scale value does not match its display text.", "SCALEの値と入力文字列が一致していません。"],
  ["offset must be finite.", "OFFSETには有限の値を指定してください。"],
  ["minimum must be finite or blank.", "MINには有限の値を指定するか、空欄にしてください。"],
  ["maximum must be finite or blank.", "MAXには有限の値を指定するか、空欄にしてください。"],
  ["minimum cannot exceed maximum.", "MINはMAX以下にしてください。"],
  ["Derived Signal ID is required.", "派生シグナルIDを入力してください。"],
  ["Derived Signal name is required.", "派生シグナル名を入力してください。"],
  ["expression is empty.", "計算式を入力してください。"],
  ["expression must reference at least one earlier Signal.", "計算式では上の行のシグナルを1つ以上参照してください。"],
  ["“{0}” is not an earlier Signal or Derived Signal.", "「{0}」は上の行のシグナルまたは派生シグナルではありません。"],
  ["an input Signal is required.", "入力シグナルを指定してください。"],
  ["Lookup Table requires at least two points.", "線形補間には2点以上を指定してください。"],
  ["Lookup Table points must be finite numbers.", "線形補間の各点には有限の値を指定してください。"],
  ["Lookup Table INPUT {0} is duplicated.", "線形補間のINPUT {0}が重複しています。"],
  ["Filter time must be a positive finite number of seconds.", "フィルターの時間には0より大きい有限の値を秒で指定してください。"],
  ["Expression result is not finite.", "計算結果が有限の値ではありません。"],
  ["Unexpected token “{0}”.", "「{0}」はここには指定できません。"],
  ["Expected a number, variable, or function at “{0}”.", "「{0}」には数値、変数、関数を指定してください。"],
  ["Expected “)” after function arguments.", "関数の引数の後に「)」が必要です。"],
  ["Expected “)”.", "「)」が必要です。"],
  ["Invalid number at position {0}.", "{0}文字目の数値が不正です。"],
  ["Expected “]” for Signal name at position {0}.", "{0}文字目のシグナル名に「]」が必要です。"],
  ["Signal name is empty at position {0}.", "{0}文字目のシグナル名が空です。"],
  ["Unsupported character “{0}” at position {1}.", "{1}文字目の「{0}」は使用できません。"],
  ["Variable “{0}” is missing or invalid.", "変数「{0}」が存在しないか、無効です。"],
  ["Division by zero.", "0で除算しています。"],
  ["Unknown function “{0}” or invalid argument count.", "関数「{0}」が存在しないか、引数の数が不正です。"],
  ["decoded integer cannot be represented exactly as a JavaScript number.", "デコードした整数を数値として正確に表現できません。"],
  ["converted value is not finite.", "変換後の値が有限の値ではありません。"],
  ["Input Signal “{0}” is missing or invalid.", "入力シグナル「{0}」が存在しないか、無効です。"],
  ["Input {0} is outside the Lookup Table range.", "入力値{0}が線形補間の範囲を超えています。"],
  ["CAN ID is already registered as “{0}”.", "CAN IDは「{0}」に登録済みです。"],
  ["Signal ID “{0}” is already used by another frame.", "シグナルID「{0}」は別のフレームで使用されています。"],
  ["CSV file has no header row.", "CSVにヘッダー行がありません。"],
  ["Timestamp column “{0}” was not found.", "時刻列「{0}」が見つかりません。"],
  ["Value column “{0}” was not found.", "値列「{0}」が見つかりません。"],
  ["CSV row has an invalid Timestamp.", "CSV行の時刻が不正です。"],
  ["Column “{0}” has a non-numeric value.", "列「{0}」に数値ではない値があります。"],
  ["Calculation cycle detected: {0}.", "計算の循環参照があります: {0}。"],
  ["Calculation Timestamp source was not found.", "計算の時刻参照元が見つかりません。"],
  ["Input “{0}” was not found.", "入力「{0}」が見つかりません。"],
  ["Expression variable “{0}” is not mapped to a Signal.", "計算式の変数「{0}」にシグナルが割り当てられていません。"],
  ["Lookup Table “{0}” was not found.", "線形補間テーブル「{0}」が見つかりません。"],
  ["Lookup input “{0}” is not mapped.", "線形補間の入力「{0}」が割り当てられていません。"],
  ["Unsupported or malformed CAN FD row.", "CAN FD行の形式が未対応か、不正です。"],
  ["CAN FD BRS/ESI flags are malformed.", "CAN FDのBRS/ESIフラグが不正です。"],
  ["CAN FD DLC or payload length is invalid.", "CAN FDのDLCまたはデータ長が不正です。"],
  ["CAN FD payload is shorter than its declared length or contains invalid bytes.", "CAN FDのデータが指定された長さより短いか、不正なバイトを含んでいます。"],
  ["Unsupported ASC row was not imported.", "未対応の形式のASC行は読み込まれませんでした。"],
  ["Classic CAN header is malformed.", "Classic CANのヘッダーが不正です。"],
  ["Classic CAN payload is shorter than its DLC or contains invalid bytes.", "Classic CANのデータがDLCより短いか、不正なバイトを含んでいます。"],
  ["Plugin has not been loaded.", "プラグインはまだ読み込まれていません。"],
  ["A workspace folder is required.", "ワークスペースフォルダを開いてください。"],
  ["Plugin is not registered.", "プラグインが登録されていません。"],
  ["CAN Frame is not registered.", "フレームが登録されていません。"],
  ["Plugin is not loaded.", "プラグインが読み込まれていません。"],
  ["Source exports Plugin “{0}”, expected “{1}”.", "参照元のプラグインIDは「{0}」です。「{1}」を指定してください。"],
  ["A workspace is required to resolve the Plugin source.", "プラグインの参照元を読み込むにはワークスペースを開いてください。"],
  ["Plugin “{0}” is already registered.", "プラグイン「{0}」は登録済みです。"],
];

const rules = translations.map(([english, japanese]) => {
  const keys: string[] = [];
  const pattern = english.split(/(\{\d+\})/).map((part) => {
    if (/^\{\d+\}$/.test(part)) { keys.push(part); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { match: new RegExp(`^${pattern}$`), japanese, keys };
});

/** Unknown messages (including Plugin and OS errors) retain the original detail. */
export function diagnosticText(message: string, language: string): string {
  if (!language.toLowerCase().startsWith('ja')) return message;
  const translate = (text: string): string | undefined => {
    for (const rule of rules) {
      const match = rule.match.exec(text);
      if (match) return rule.japanese.replace(/\{\d+\}/g, (key) => match[rule.keys.indexOf(key) + 1] ?? key);
    }
    return undefined;
  };
  const whole = translate(message); if (whole !== undefined) return whole;
  // Validators prefix a message with the user's Signal name. Preserve that name verbatim, including colons.
  for (let index = message.indexOf(': '); index >= 0; index = message.indexOf(': ', index + 2)) {
    const suffix = translate(message.slice(index + 2));
    if (suffix !== undefined) return message.slice(0, index + 2) + suffix;
  }
  return message;
}
