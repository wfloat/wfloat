#include "DescriptorSources.h"
#pragma once
#include "TcpSnapshot.h"
#include "SkywalkFlowSource.h"
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <chrono>
#include <cstring>
namespace bench {
inline std::string tcpLoopbackProbe() {
  struct File {int fd=-1;~File(){if(fd>=0)close(fd);}} listener,client,server;
  const auto failure=[](const char *where){return jsonObject({{"error",jsonString(where)},{"errno",std::to_string(errno)}});};
  listener.fd=socket(AF_INET,SOCK_STREAM,0);client.fd=socket(AF_INET,SOCK_STREAM,0);if(listener.fd<0||client.fd<0)return failure("socket");
  for(int fd:{listener.fd,client.fd}) {if(fcntl(fd,F_SETFL,O_NONBLOCK)<0)return failure("fcntl nonblock");fcntl(fd,F_SETFD,FD_CLOEXEC);}
  sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  if(bind(listener.fd,(sockaddr *)&address,sizeof(address))<0||listen(listener.fd,1)<0)return failure("bind/listen loopback");
  socklen_t length=sizeof(address);if(getsockname(listener.fd,(sockaddr *)&address,&length)<0)return failure("getsockname");
  if(connect(client.fd,(sockaddr *)&address,length)<0&&errno!=EINPROGRESS)return failure("connect");
  pollfd ready{client.fd,POLLOUT,0};if(poll(&ready,1,1000)<=0)return jsonObject({{"error",jsonString("loopback connect not ready within one second")}});
  int connectError=0;length=sizeof(connectError);if(getsockopt(client.fd,SOL_SOCKET,SO_ERROR,&connectError,&length)<0)return failure("SO_ERROR");if(connectError)return jsonObject({{"error",jsonString("connect failed")},{"errno",std::to_string(connectError)}});
  const auto acceptDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
  while(server.fd<0&&std::chrono::steady_clock::now()<acceptDeadline){
    pollfd incoming{listener.fd,POLLIN,0};const int rc=poll(&incoming,1,20);
    if(rc<0&&errno!=EINTR)return failure("poll listener");
    if(rc<=0)continue;
    server.fd=accept(listener.fd,nullptr,nullptr);
    if(server.fd<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR)return failure("accept");
  }
  if(server.fd<0)return jsonObject({{"error",jsonString("listener not ready within one second")}});if(fcntl(server.fd,F_SETFL,O_NONBLOCK)<0)return failure("server nonblock");fcntl(server.fd,F_SETFD,FD_CLOEXEC);
#ifdef __APPLE__
  int noSigpipe=1;setsockopt(client.fd,SOL_SOCKET,SO_NOSIGPIPE,&noSigpipe,sizeof(noSigpipe));
#endif
  const auto beforeClient=tcpSnapshot(client.fd),beforeServer=tcpSnapshot(server.fd);
  constexpr size_t total=65536;unsigned char data[4096];memset(data,0x3c,sizeof(data));unsigned char received[4096];size_t sent=0,read=0;bool verified=true;int transferError=0;
  const auto start=std::chrono::steady_clock::now();
  while(read<total && std::chrono::steady_clock::now()-start<std::chrono::seconds(2)) {
    bool progress=false;
    if(sent<total) {
#ifdef __APPLE__
      const int flags=0;
#else
      const int flags=MSG_NOSIGNAL;
#endif
      const auto n=send(client.fd,data,std::min(sizeof(data),total-sent),flags);if(n>0){sent+=n;progress=true;}else if(n<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR){transferError=errno;break;}
    }
    const auto n=recv(server.fd,received,std::min(sizeof(received),total-read),0);if(n>0){for(ssize_t i=0;i<n;++i)if(received[i]!=0x3c)verified=false;read+=n;progress=true;}else if(n==0){transferError=ECONNRESET;break;}else if(errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR){transferError=errno;break;}
    if(!progress){pollfd p{server.fd,POLLIN,0};poll(&p,1,1);}
  }
  const auto afterClient=tcpSnapshot(client.fd),afterServer=tcpSnapshot(server.fd);
  std::string skywalk="null";
#ifdef __APPLE__
  skywalk=skywalkFlowSource(client.fd);
#endif
  return jsonObject({{"skywalkOwnedFlow",skywalk},{"error",transferError?jsonString("transfer error"):read<total?jsonString("transfer deadline"):"null"},{"transferErrno",std::to_string(transferError)},{"scope",jsonString("owned IPv4 loopback sockets; not external network performance")},{"sentBytes",jsonInteger(sent)},{"receivedBytes",jsonInteger(read)},{"payloadVerified",verified&&read==total?"true":"false"},{"beforeClient",beforeClient},{"beforeServer",beforeServer},{"afterClient",afterClient},{"afterServer",afterServer},{"clientDescriptor",descriptorDetails(client.fd)},{"serverDescriptor",descriptorDetails(server.fd)}});
}
inline std::string socketSignalProbe() {
  // Independent local resource probes still run if TCP setup is unavailable.
  auto result=tcpLoopbackProbe();result.pop_back();
  return result+",\"ownedPipeProbe\":"+ownedPipeProbe()+",\"ownedSocketQueueProbe\":"+ownedSocketQueueProbe()+"}";
}

}
