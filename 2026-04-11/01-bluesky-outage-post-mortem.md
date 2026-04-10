# Bluesky 2026 年 4 月故障复盘

> 原文：[April 2026 Outage Post-Mortem](https://pckt.blog/b/jcalabro/april-2026-outage-post-mortem-219ebg2)
> 翻译日期：2026-04-11

大家好！我是 [Jim](https://calabro.io/)，在 Bluesky 负责系统相关的工作。今天我要跟大家分享本周一发生的事件详情，这次故障导致 Bluesky 间歇性宕机约 8 小时，影响了大约一半的用户。

首先，我要为服务中断向用户道歉。这是我入职以来遇到的最严重的一次宕机。这绝对不可接受。

其次，如果你觉得这份工作很有意思，[我们正在招人](https://bsky.social/about/join)！

## 问题所在

问题其实在那个周末早些时候就开始了。以下是 Bluesky AppView 在那个糟糕的周一之前几天的请求图表：

黄/绿色部分不重要，但那些下跌非常严重！它们代表了真实的用户可感知的停机时间。哎哟！

我们在 4 月 4 日星期六收到了告警。我看了一下，以为可能是传输问题。我们有相当完善的网络监控，一切看起来都很正常。

不过，我确实注意到 AppView 数据后端（称为"数据平面"）中出现了一些异常日志：

```json
{
  "time": "2026-04-03T22:16:07.944910324Z",
  "level": "ERROR",
  "msg": "failed to set post cache item",
  "uri": "at://did:plc:mhvcx2z27zq2jtb3i7f5beb7/app.bsky.feed.post/3mim4uloar22m",
  "error": "dial tcp 127.32.0.1:0->127.0.0.1:11211: bind: address already in use"
}
```

这些日志峰值的时间与用户可感知的流量下降相吻合，这很合理。我们的数据平面大量使用 memcached 来减轻主 Scylla 数据库的负载，如果我们耗尽了端口，那是个大问题。

## 根本原因

由于可观测性不够完善，我们花了很长时间才找到真正的问题所在。我们在数据平面通常有很好的监控，但它确实假设每个请求都很小，不会做太多工作。

这个特定的 RPC（GetPostRecord）接收一批帖子 URI，然后在 memcached 中查找所有这些 URI，缓存未命中时再查 Scylla。我忽略的是，我们上周部署了一个新的内部服务，它每秒发送不到三个 GetPostRecord 请求，但有时会一次发送 15000-20000 个 URI 的批次。通常我们每个请求可能只做 1-50 个帖子查询。

数据平面中的每个 RPC 处理程序都做了有界并发控制（即 [errgroup.SetLimit](https://pkg.go.dev/golang.org/x/sync/errgroup#Group.SetLimit)）。然而，这个端点没有！它是整个系统中唯一缺失这个控制的端点。

这意味着我们会为一个请求启动 15000-20000 个 goroutine，通过大量连接猛烈冲击 memcached，然后关闭它们并将它们返回给操作系统，因为我们的最大空闲连接池大小是 1000。它们会在 [TCP TIME_WAIT](https://upload.wikimedia.org/wikipedia/commons/f/f6/Tcp_state_diagram_fixed_new.svg) 状态中积累，最终耗尽所有可用端口。

Go 代码如下：

```go
func GetPostRecords(uris []string) ([]*Post, error) {
  posts := make([]*Post, len(uris))

  var group errgroup.Group
  // group.SetLimit(50) <-- 这是关键缺失的一行！

  for ndx, uri := range uris {
    group.Go(func() error {
      post, err := memcache.GetPost(uri)
      if err != nil {
        return err
      }
      if post != nil {
        posts[ndx] = post
        return nil
      }

      post, err = scylla.GetPost(uri)
      if err != nil {
        return err
      }
      if post != nil {
        posts[ndx] = post
        return nil
      }

      return nil
    })
  }

  if err := group.Wait(); err != nil {
    return nil, err
  }

  return posts, nil
}
```

哎哟！我们几乎立刻就看到了端口耗尽，但不知道根本原因是什么。我们有很多地方使用 memcached，我特意挑出了那条 JSON 日志，因为它明确指出是帖子缓存的问题。我们还有用户缓存、交互计数缓存等等。我们看到所有缓存类型都出现错误日志（这很合理，因为所有 memcached 行为都受影响），所以一开始完全不清楚是 GetPostRecord 的问题。

还要注意，新的内部服务目前只在我们其中一个数据中心运行，这就是为什么我们只看到那个站点出现问题。这确实增加了困惑，因为我们在数据平面没有按客户端的指标。

## 死亡螺旋

直到本周三我们才找到并修复这个问题，尽管服务在周一已经稳定。那么在此之前我们做了什么来止血呢？

我周六和周日大部分时间都在追查这个问题，但仍然没有找到根本原因，服务一瘸一拐地运行着，但还活着。然后，周一，事情突然爆发了。结果发现我们让自己陷入了死亡螺旋！这个负反馈循环导致了周一的大规模宕机。

事实证明，每当我们从 memcache 收到错误时，我们都会记录它。我们每秒向 memcached 实例发送数百万个请求，所以我们试图每秒记录数百万条日志。

[Go 中的日志记录](https://github.com/golang/go/blob/0e31741044d519065f62a5e96499909d6cd230dc/src/internal/poll/fd_unix.go#L374)使用阻塞的 [write(2)](https://man7.org/linux/man-pages/man2/write.2.html) 系统调用。这个大量的阻塞系统调用加上我们要继续每秒处理数百万个请求的尝试，导致 Go 运行时生成了更多的操作系统线程（[Go 术语](https://ashutoshkumars1ngh.medium.com/golang-deepdive-architecture-and-internals-cc2021a83962)中的 M）。大约比健康基线多 10 倍的 M（150 对 1500）。

更大批量的 M 反过来给垃圾回收器施加了压力：

停止世界 GC 持续时间中的那些巨大暂停意味着请求在停滞。

再加上我们有一些非常激进调整的 [GOGC](https://go.dev/doc/gc-guide#GOGC) 和 [GOMEMLIMIT](https://go.dev/doc/gc-guide#Memory_limit) 环境变量值和内存限制，这意味着我们的数据平面实际上经常 OOM！这就是为什么服务会运行大约 30 分钟，然后宕机一段时间，再恢复一会儿，如此循环。

OOM 显然很糟糕（我们应该零 OOM），但通常它们不是什么大问题。然而，memcached 连接池已经饱和这一事实意味着，当数据平面重启时，它启动时无法创建新的 memcached 连接，因为那些现有连接卡在 TIME_WAIT 中，这导致更多的端口耗尽问题。死亡螺旋！

临时修复方案很疯狂但有效。这就是我们在周一实际修复宕机的方法，在我们找到真正的根本原因之前：

```go
// 使用自定义拨号器为每个连接选择随机回环 IP。
// 这避免了容器重启时单个 IP 上的临时端口耗尽
// （旧进程的 TIME_WAIT 套接字阻塞了固定 IP）。
memcachedClient.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
  ip := net.IPv4(127, byte(1+rand.IntN(254)), byte(rand.IntN(256)), byte(1+rand.IntN(254)))
  d := net.Dialer{LocalAddr: &net.TCPAddr{IP: ip}}
  return d.DialContext(ctx, network, address)
}
```

这让我们摆脱了死亡循环，因为它扩展了客户端 IP+端口空间。疯狂但有效！我们在修复了真正的根本原因后删除了这段代码。

## 总结

在我[最近的演讲](https://www.youtube.com/watch?v=2T15FAihJCA)中，我提到你应该在宕机之前添加广泛的可观测性。我们确实有很多，但永远不够！我们需要添加按客户端的可观测性，以及更好地获取客户端发送少量大请求时的指标。

所有信息都埋在那里，但当这么多东西同时崩溃时，很难知道从哪里看。你需要有心理纪律和指标中的高粒度，才能穿透噪音找到真正的根本原因。这是艰苦的工作！

另外，记录太多日志也不好。这里那里记录一些没问题，但我更愿意使用 Prometheus 指标或 OTEL 追踪，因为它们更适合大规模系统。

最后，再次为广泛的服务中断道歉。我和团队非常重视我们的运营，这真是糟糕的一天。

编辑：另外，状态页面说这是第三方提供商的问题。显然不是，为那个错误沟通道歉！在我发布那个状态页面更新时，我正在查看一些 traceroute，显示从云提供商到我们数据中心有一些相当严重的丢包，但那些不是问题的根本原因。