This is a trading execution mobile web app that uses:

1. KlineCharts for charting an inputed stock ticker (daily chart back to a year), loads that chart data from Alpaca API
2. Backend is a Typescript serverless infrastructure on Cloudflare Workers and uses Cloudflare Access to allow an Gmail user way to authenticate through their account
3. User can adjust price lines in the stock chart as input to execute a trade through multiple brokers that include Interactive Brokers and Schwab
  a. For Interactive Brokers, we'll use its OAuth 1.0A IBKR API via the @quentinadam/ibkr. Any client secrets can be stored via Cloudflare KV or D1
  b. For Schwab, we'll use the @sudowealth/schwab-api library. Like the IBKR API, we'll store necessary secrets via Cloudflare KV or D1
