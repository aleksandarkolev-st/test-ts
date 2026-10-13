#pragma once
// Post-capture CPU contract simulation only, never an application dependency.
// Models width-32 collective rendezvous and source membership. It does not
// model independent GPU scheduling, memory fences, FTZ, or NVIDIA hardware.
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
#define __device__
#define __host__
#define __forceinline__ inline
struct Dim { unsigned x=0,y=0,z=0; };
inline thread_local Dim threadIdx;
inline const Dim blockDim{32,1,1};
inline thread_local unsigned collective_step=0,shuffle_count=0;
struct WarpResult { float value; std::uint32_t ballot; };
struct WarpCollective {
    std::mutex mutex;
    std::condition_variable changed;
    unsigned step=0;
    std::uint32_t arrived=0,departed=0,mask=0;
    int kind=0;
    std::array<float,32> values{};
    std::array<unsigned,32> predicates{};
    std::uint32_t simulatedActiveMask=0xffffffffu;
    unsigned maximumShuffleCalls=0;
    void reset(std::uint32_t active,unsigned maximum) {
        step=0;arrived=departed=mask=0;kind=0;
        simulatedActiveMask=active;maximumShuffleCalls=maximum;
    }
} inline collective;
inline WarpResult exchange(unsigned mask,float value,int source,int kind,unsigned predicate=0) {
    const unsigned lane=threadIdx.x;
    if(lane>=32)throw std::runtime_error("lane outside physical warp");
    const std::uint32_t bit=std::uint32_t(1)<<lane;
    if(!(mask&bit))throw std::runtime_error("caller not named in its collective mask");
    if(kind==1&&(source<0||source>=32||!(mask&(std::uint32_t(1)<<source))))
        throw std::runtime_error("shuffle source does not participate");
    if(kind==1&&++shuffle_count>collective.maximumShuffleCalls)
        throw std::runtime_error("shuffle count exceeds declared contract");
    std::unique_lock<std::mutex> lock(collective.mutex);
    auto wait=[&](auto condition) {
        if(!collective.changed.wait_for(lock,std::chrono::seconds(2),condition))
            throw std::runtime_error("unmatched collective or nontermination");
    };
    wait([&]{return collective.step==collective_step;});
    if(collective.arrived==0){collective.mask=mask;collective.kind=kind;}
    if(collective.mask!=mask||collective.kind!=kind)
        throw std::runtime_error("collective instances or participant masks differ");
    if(collective.arrived&bit)throw std::runtime_error("duplicate caller in one instance");
    collective.values[lane]=value;collective.predicates[lane]=predicate;
    collective.arrived|=bit;
    if(collective.arrived==mask)collective.changed.notify_all();
    wait([&]{return collective.arrived==mask;});
    WarpResult result{value,0};
    if(kind==1)result.value=collective.values[source];
    if(kind==2)for(unsigned i=0;i<32;++i)
        if((mask&(std::uint32_t(1)<<i))&&collective.predicates[i])
            result.ballot|=std::uint32_t(1)<<i;
    ++collective_step;collective.departed|=bit;
    if(collective.departed==mask) {
        collective.arrived=collective.departed=0;
        ++collective.step;collective.changed.notify_all();
    }
    return result;
}
inline float __shfl_sync(unsigned mask,float value,int source,int width=32) {
    if(width!=32)throw std::runtime_error("harness scope is physical width32 only");
    return exchange(mask,value,source,1).value;
}
inline float __shfl_down_sync(unsigned mask,float value,unsigned delta,int width=32) {
    unsigned source=threadIdx.x+delta;
    if(source>=static_cast<unsigned>(width))source=threadIdx.x;
    return __shfl_sync(mask,value,static_cast<int>(source),width);
}
inline float __shfl_up_sync(unsigned mask,float value,unsigned delta,int width=32) {
    const unsigned source=threadIdx.x>=delta?threadIdx.x-delta:threadIdx.x;
    return __shfl_sync(mask,value,static_cast<int>(source),width);
}
inline float __shfl_xor_sync(unsigned mask,float value,int delta,int width=32) {
    return __shfl_sync(mask,value,static_cast<int>(threadIdx.x)^delta,width);
}
inline unsigned __ballot_sync(unsigned mask,int predicate) {
    return exchange(mask,0,0,2,predicate).ballot;
}
inline void __syncwarp(unsigned mask=0xffffffffu){exchange(mask,0,0,3);}
inline unsigned __activemask(){return collective.simulatedActiveMask;}
inline float __fadd_rn(float a,float b){volatile float result=a+b;return result;}
