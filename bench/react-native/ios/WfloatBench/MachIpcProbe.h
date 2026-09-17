#pragma once
// Owned port and empty messages only; observe kernel queue accounting directly.
static NSDictionary *machIpcProbe() {
  struct Port {mach_port_t name=MACH_PORT_NULL;~Port(){if(name!=MACH_PORT_NULL)mach_port_destroy(mach_task_self(),name);}} port;
  auto code=mach_port_allocate(mach_task_self(),MACH_PORT_RIGHT_RECEIVE,&port.name);
  if(code!=KERN_SUCCESS)return @{@"error":@"mach_port_allocate",@"returnCode":@(code)};
  code=mach_port_insert_right(mach_task_self(),port.name,port.name,MACH_MSG_TYPE_MAKE_SEND);
  if(code!=KERN_SUCCESS)return @{@"error":@"mach_port_insert_right",@"returnCode":@(code)};
  NSMutableArray *phases=[NSMutableArray new];
  const auto sample=[&](NSString *phase) {
    mach_port_info_ext_t v{};mach_msg_type_number_t count=MACH_PORT_INFO_EXT_COUNT;const auto result=mach_port_get_attributes(mach_task_self(),port.name,MACH_PORT_INFO_EXT,(mach_port_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(result==KERN_SUCCESS){FIELD(mpie_status.mps_pset);FIELD(mpie_status.mps_seqno);FIELD(mpie_status.mps_mscount);FIELD(mpie_status.mps_qlimit);FIELD(mpie_status.mps_msgcount);FIELD(mpie_status.mps_sorights);FIELD(mpie_status.mps_srights);FIELD(mpie_status.mps_pdrequest);FIELD(mpie_status.mps_nsrequest);FIELD(mpie_status.mps_flags);FIELD(mpie_boost_cnt);}
    [phases addObject:@{@"phase":phase,@"returnCode":@(result),@"values":result==KERN_SUCCESS?values:(id)NSNull.null,@"receivedUptimeMs":@(stamp())}];
  };
  sample(@"empty");NSMutableArray *sends=[NSMutableArray new],*receives=[NSMutableArray new];
  for(int i=0;i<3;++i){mach_msg_header_t message{};message.msgh_bits=MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0);message.msgh_size=sizeof(message);message.msgh_remote_port=port.name;message.msgh_id=100+i;
    const auto result=mach_msg(&message,MACH_SEND_MSG|MACH_SEND_TIMEOUT,sizeof(message),0,MACH_PORT_NULL,0,MACH_PORT_NULL);[sends addObject:@(result)];if(result!=MACH_MSG_SUCCESS)break;
  }
  sample(@"after_sends");
  for(int i=0;i<3;++i){struct {mach_msg_header_t header;mach_msg_max_trailer_t trailer;} message{};
    const auto result=mach_msg(&message.header,MACH_RCV_MSG|MACH_RCV_TIMEOUT,0,sizeof(message),port.name,0,MACH_PORT_NULL);[receives addObject:@{@"returnCode":@(result),@"messageId":result==MACH_MSG_SUCCESS?@(message.header.msgh_id):(id)NSNull.null}];if(result!=MACH_MSG_SUCCESS)break;
  }
  sample(@"after_receives");return @{@"error":NSNull.null,@"scope":@"owned Mach port with three empty messages",@"sends":sends,@"receives":receives,@"phases":phases};
}
