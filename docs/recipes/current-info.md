# Recipe: current information (weather, news, prices)

The master has no browser/network tool. It is a controller.

Correct flow:

1. if the request lacks a required input (city, ticker, URL), ask one short
   clarifying question
2. create a worker task with the current data requirement
3. worker fetches from a network/web source
4. master reports the result and keeps the child thread link

Example:

```text
User: 今天天气怎么样？
Master: 你想查哪个城市的天气？
User: 杭州
Master: [creates a child task]
```

If the master says “I have no network interface”, it is an old/wrong
configuration. Update the leader prompt or use the current version.
