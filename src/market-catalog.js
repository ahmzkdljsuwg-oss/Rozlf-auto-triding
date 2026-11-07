'use strict';

// Public market instruments used for analysis. These are reference feeds, not
// ExpertOption quotes: OTC and Smarty assets are account-specific and cannot be
// listed without an official ExpertOption asset endpoint.
const CATALOG = [
  // Forex
  { symbol: 'EURUSD', yahoo: 'EURUSD=X', name: 'Euro / US Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'GBPUSD', yahoo: 'GBPUSD=X', name: 'British Pound / US Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'USDJPY', yahoo: 'USDJPY=X', name: 'US Dollar / Japanese Yen', category: 'forex', pip: 0.01 },
  { symbol: 'AUDUSD', yahoo: 'AUDUSD=X', name: 'Australian Dollar / US Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'USDCAD', yahoo: 'USDCAD=X', name: 'US Dollar / Canadian Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'NZDUSD', yahoo: 'NZDUSD=X', name: 'New Zealand Dollar / US Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'USDCHF', yahoo: 'USDCHF=X', name: 'US Dollar / Swiss Franc', category: 'forex', pip: 0.0001 },
  { symbol: 'EURJPY', yahoo: 'EURJPY=X', name: 'Euro / Japanese Yen', category: 'forex', pip: 0.01 },
  { symbol: 'GBPJPY', yahoo: 'GBPJPY=X', name: 'British Pound / Japanese Yen', category: 'forex', pip: 0.01 },
  { symbol: 'EURGBP', yahoo: 'EURGBP=X', name: 'Euro / British Pound', category: 'forex', pip: 0.0001 },
  { symbol: 'AUDJPY', yahoo: 'AUDJPY=X', name: 'Australian Dollar / Japanese Yen', category: 'forex', pip: 0.01 },
  { symbol: 'CADJPY', yahoo: 'CADJPY=X', name: 'Canadian Dollar / Japanese Yen', category: 'forex', pip: 0.01 },
  { symbol: 'CHFJPY', yahoo: 'CHFJPY=X', name: 'Swiss Franc / Japanese Yen', category: 'forex', pip: 0.01 },
  { symbol: 'EURCHF', yahoo: 'EURCHF=X', name: 'Euro / Swiss Franc', category: 'forex', pip: 0.0001 },
  { symbol: 'EURAUD', yahoo: 'EURAUD=X', name: 'Euro / Australian Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'EURCAD', yahoo: 'EURCAD=X', name: 'Euro / Canadian Dollar', category: 'forex', pip: 0.0001 },
  { symbol: 'GBPCHF', yahoo: 'GBPCHF=X', name: 'British Pound / Swiss Franc', category: 'forex', pip: 0.0001 },
  { symbol: 'NZDJPY', yahoo: 'NZDJPY=X', name: 'New Zealand Dollar / Japanese Yen', category: 'forex', pip: 0.01 },

  // Metals and commodities
  { symbol: 'XAUUSD', yahoo: 'GC=F', name: 'Gold', category: 'commodities', pip: 0.1 },
  { symbol: 'XAGUSD', yahoo: 'SI=F', name: 'Silver', category: 'commodities', pip: 0.01 },
  { symbol: 'WTIUSD', yahoo: 'CL=F', name: 'WTI Crude Oil', category: 'commodities', pip: 0.01 },
  { symbol: 'BRENTUSD', yahoo: 'BZ=F', name: 'Brent Crude Oil', category: 'commodities', pip: 0.01 },
  { symbol: 'NATGAS', yahoo: 'NG=F', name: 'Natural Gas', category: 'commodities', pip: 0.001 },
  { symbol: 'COPPER', yahoo: 'HG=F', name: 'Copper', category: 'commodities', pip: 0.0005 },
  { symbol: 'CORN', yahoo: 'ZC=F', name: 'Corn', category: 'commodities', pip: 0.25 },
  { symbol: 'WHEAT', yahoo: 'ZW=F', name: 'Wheat', category: 'commodities', pip: 0.25 },

  // Indices
  { symbol: 'US500', yahoo: '^GSPC', name: 'US 500', category: 'indices', pip: 0.1 },
  { symbol: 'US100', yahoo: '^NDX', name: 'US 100', category: 'indices', pip: 0.1 },
  { symbol: 'US30', yahoo: '^DJI', name: 'US 30', category: 'indices', pip: 1 },
  { symbol: 'GER40', yahoo: '^GDAXI', name: 'Germany 40', category: 'indices', pip: 0.1 },
  { symbol: 'UK100', yahoo: '^FTSE', name: 'UK 100', category: 'indices', pip: 0.1 },
  { symbol: 'JP225', yahoo: '^N225', name: 'Japan 225', category: 'indices', pip: 1 },
  { symbol: 'HK50', yahoo: '^HSI', name: 'Hong Kong 50', category: 'indices', pip: 1 },
  { symbol: 'AUS200', yahoo: '^AXJO', name: 'Australia 200', category: 'indices', pip: 0.1 },

  // Crypto
  { symbol: 'BTCUSD', yahoo: 'BTC-USD', name: 'Bitcoin', category: 'crypto', pip: 1 },
  { symbol: 'ETHUSD', yahoo: 'ETH-USD', name: 'Ethereum', category: 'crypto', pip: 0.1 },
  { symbol: 'SOLUSD', yahoo: 'SOL-USD', name: 'Solana', category: 'crypto', pip: 0.01 },
  { symbol: 'XRPUSD', yahoo: 'XRP-USD', name: 'XRP', category: 'crypto', pip: 0.0001 },
  { symbol: 'BNBUSD', yahoo: 'BNB-USD', name: 'BNB', category: 'crypto', pip: 0.1 },
  { symbol: 'ADAUSD', yahoo: 'ADA-USD', name: 'Cardano', category: 'crypto', pip: 0.0001 },
  { symbol: 'DOGEUSD', yahoo: 'DOGE-USD', name: 'Dogecoin', category: 'crypto', pip: 0.00001 },
  { symbol: 'LTCUSD', yahoo: 'LTC-USD', name: 'Litecoin', category: 'crypto', pip: 0.01 },
  { symbol: 'DOTUSD', yahoo: 'DOT-USD', name: 'Polkadot', category: 'crypto', pip: 0.001 },
  { symbol: 'AVAXUSD', yahoo: 'AVAX-USD', name: 'Avalanche', category: 'crypto', pip: 0.01 },

  // Stocks
  { symbol: 'AAPL', yahoo: 'AAPL', name: 'Apple', category: 'stocks', pip: 0.01 },
  { symbol: 'MSFT', yahoo: 'MSFT', name: 'Microsoft', category: 'stocks', pip: 0.01 },
  { symbol: 'NVDA', yahoo: 'NVDA', name: 'NVIDIA', category: 'stocks', pip: 0.01 },
  { symbol: 'AMZN', yahoo: 'AMZN', name: 'Amazon', category: 'stocks', pip: 0.01 },
  { symbol: 'GOOGL', yahoo: 'GOOGL', name: 'Alphabet', category: 'stocks', pip: 0.01 },
  { symbol: 'META', yahoo: 'META', name: 'Meta Platforms', category: 'stocks', pip: 0.01 },
  { symbol: 'TSLA', yahoo: 'TSLA', name: 'Tesla', category: 'stocks', pip: 0.01 },
  { symbol: 'NFLX', yahoo: 'NFLX', name: 'Netflix', category: 'stocks', pip: 0.01 },
  { symbol: 'AMD', yahoo: 'AMD', name: 'AMD', category: 'stocks', pip: 0.01 },
  { symbol: 'JPM', yahoo: 'JPM', name: 'JPMorgan Chase', category: 'stocks', pip: 0.01 },
  { symbol: 'XOM', yahoo: 'XOM', name: 'Exxon Mobil', category: 'stocks', pip: 0.01 },
  { symbol: 'BABA', yahoo: 'BABA', name: 'Alibaba', category: 'stocks', pip: 0.01 },

  // ETFs
  { symbol: 'SPY', yahoo: 'SPY', name: 'S&P 500 ETF', category: 'etf', pip: 0.01 },
  { symbol: 'QQQ', yahoo: 'QQQ', name: 'Nasdaq 100 ETF', category: 'etf', pip: 0.01 },
  { symbol: 'GLD', yahoo: 'GLD', name: 'Gold ETF', category: 'etf', pip: 0.01 },
  { symbol: 'SLV', yahoo: 'SLV', name: 'Silver ETF', category: 'etf', pip: 0.01 },
  { symbol: 'USO', yahoo: 'USO', name: 'Oil ETF', category: 'etf', pip: 0.01 },
  { symbol: 'TLT', yahoo: 'TLT', name: 'US 20Y Treasury ETF', category: 'etf', pip: 0.01 },
];

const CATEGORIES = [
  { id: 'all', label_en: 'All', label_ar: 'الكل' },
  { id: 'forex', label_en: 'Forex', label_ar: 'فوركس' },
  { id: 'otc', label_en: 'OTC', label_ar: 'OTC' },
  { id: 'smarty', label_en: 'Smarty', label_ar: 'Smarty' },
  { id: 'crypto', label_en: 'Crypto', label_ar: 'عملات رقمية' },
  { id: 'stocks', label_en: 'Stocks', label_ar: 'أسهم' },
  { id: 'commodities', label_en: 'Commodities', label_ar: 'سلع ومعادن' },
  { id: 'indices', label_en: 'Indices', label_ar: 'مؤشرات' },
  { id: 'etf', label_en: 'ETFs', label_ar: 'صناديق' },
];

const UNAVAILABLE_CATEGORIES = {
  otc: 'OTC assets are account-specific on ExpertOption. No approved public asset endpoint exists, so they are not listed or given invented symbols.',
  smarty: 'Smarty assets are account-specific on ExpertOption. No approved public asset endpoint exists, so they are not listed or given invented symbols.',
};

module.exports = { CATALOG, CATEGORIES, UNAVAILABLE_CATEGORIES };
