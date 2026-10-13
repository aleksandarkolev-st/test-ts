#pragma once
// CPU contract harness, not CUDA hardware execution. Include an unchanged
// answer function after this header, then call it concurrently in 19 lanes.
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
// Full physical warp laid out along x; y/z thread coordinates remain zero.
// Rank-based lane computations in valid CUDA answers must also compile.
inline const Dim blockDim{32,1,1};
inline thread_local unsigned collective_step=0;
inline thread_local unsigned shuffle_count=0;
struct Collective {
 std::mutex mutex;
 std::condition_variable changed;
 unsigned step=0,arrived=0,departed=0;
 std::array<float,19> values{};
 std::array<unsigned,19> masks{};
 std::array<unsigned,19> predicates{};
 std::array<int,19> kinds{};
 void reset(){step=arrived=departed=0;}
} inline collective;
inline float exchange(unsigned mask,float value,int source,int kind,unsigned predicate=0){
 const unsigned lane=threadIdx.x;
 if(lane>=19||mask!=0x7ffffu)throw std::runtime_error("collective mask names absent callers or excludes a required caller");
 if(kind==1&&(source<0||source>=19))throw std::runtime_error("shuffle source does not participate");
 if(kind==1&&++shuffle_count>6)throw std::runtime_error("more than six float shuffles");
 std::unique_lock<std::mutex> lock(collective.mutex);
 auto wait=[&](auto condition){if(!collective.changed.wait_for(lock,std::chrono::seconds(1),condition))throw std::runtime_error("unmatched collective or nontermination");};
 wait([&]{return collective.step==collective_step;});
 collective.values[lane]=value;collective.kinds[lane]=kind;collective.masks[lane]=mask;collective.predicates[lane]=predicate;
 if(++collective.arrived==19)collective.changed.notify_all();
 wait([&]{return collective.arrived==19;});
 for(unsigned i=0;i<19;i++)if(collective.kinds[i]!=kind||collective.masks[i]!=mask)throw std::runtime_error("different collectives at the same step");
 float result=value;
 if(kind==1)result=collective.values[source];
 if(kind==2){unsigned bits=0;for(unsigned i=0;i<19;i++)if(collective.predicates[i])bits|=1u<<i;result=static_cast<float>(bits);}
 ++collective_step;
 if(++collective.departed==19){collective.arrived=collective.departed=0;++collective.step;collective.changed.notify_all();}
 return result;
}
inline float __shfl_sync(unsigned mask,float value,int source,int width=32){
 if(width!=32)throw std::runtime_error("this harness validates physical width 32 only");
 return exchange(mask,value,source,1);
}
inline float __shfl_down_sync(unsigned mask,float value,unsigned delta,int width=32){
 unsigned source=threadIdx.x+delta;if(source>=static_cast<unsigned>(width))source=threadIdx.x;
 return __shfl_sync(mask,value,static_cast<int>(source),width);
}
inline float __shfl_up_sync(unsigned mask,float value,unsigned delta,int width=32){
 unsigned source=threadIdx.x>=delta?threadIdx.x-delta:threadIdx.x;
 return __shfl_sync(mask,value,static_cast<int>(source),width);
}
inline float __shfl_xor_sync(unsigned mask,float value,int delta,int width=32){return __shfl_sync(mask,value,static_cast<int>(threadIdx.x)^delta,width);}
inline unsigned __ballot_sync(unsigned mask,int predicate){return static_cast<unsigned>(exchange(mask,0,0,2,predicate));}
inline void __syncwarp(unsigned mask=0xffffffffu){exchange(mask,0,0,3);}
// The converged harness returns all 19 lanes. It cannot certify that using
// activemask inside a divergent GPU region is safe; that requires manual review.
inline unsigned __activemask(){return 0x7ffffu;}
inline float __fadd_rn(float a,float b){volatile float result=a+b;return result;}
template<class Function> void check_sum19(Function function){
 for(int probe=-1;probe<19;probe++){
  collective.reset();std::array<float,19> output{};std::array<std::exception_ptr,19> errors{};std::vector<std::thread> threads;
  for(unsigned lane=0;lane<19;lane++)threads.emplace_back([&,lane]{
   threadIdx.x=lane;collective_step=shuffle_count=0;
   try{output[lane]=function(probe<0?1.f:(probe==static_cast<int>(lane)?1.f:0.f));}catch(...){errors[lane]=std::current_exception();}
  });
  for(auto& thread:threads)thread.join();
  for(auto& error:errors)if(error)std::rethrow_exception(error);
  for(float value:output)if(value!=(probe<0?19.f:1.f))throw std::runtime_error("input coverage or all-caller return invariant failed");
 }
}
