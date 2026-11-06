declare module "word-extractor" { export default class WordExtractor { extract(src: Buffer | string): Promise<{ getBody(): string }>; } }
