// Grader sanity fixture, not model output and not application code.
#include "cuda-warp-contract-harness-v73.hpp"
#include <cassert>
#include <exception>
#include <iostream>

template<class Function>
unsigned callers(std::vector<unsigned> lanes,unsigned active,unsigned maximum,Function f) {
    collective.reset(active,maximum);
    std::array<std::exception_ptr,32> errors{};
    std::vector<std::thread> workers;
    for(unsigned lane:lanes)workers.emplace_back([&,lane]{
        threadIdx={lane,0,0};collective_step=shuffle_count=0;
        try{f(lane);}catch(...){errors[lane]=std::current_exception();}
    });
    for(auto& worker:workers)worker.join();
    unsigned failures=0;for(auto error:errors)if(error)++failures;
    return failures;
}

int main() {
    std::vector<unsigned> full;
    for(unsigned i=0;i<32;++i)full.push_back(i);
    std::array<unsigned,32> votes{};
    assert(callers(full,0xffffffffu,1,[&](unsigned i){
        votes[i]=__ballot_sync(0xffffffffu,i==31);
    })==0);
    for(auto vote:votes)assert(vote==0x80000000u);

    // High ballot bits stay integers; a two-lane mask need not be contiguous.
    assert(callers({0,31},0x80000001u,1,[&](unsigned i){
        votes[i]=__ballot_sync(0x80000001u,i==31);
        assert(__shfl_sync(0x80000001u,static_cast<float>(i),31)==31.0f);
    })==0);
    assert(votes[0]==0x80000000u&&votes[31]==0x80000000u);

    std::array<float,32> values{};
    std::array<unsigned,32> counts{};
    // Full ballot, then a proper subset collective; excluded callers return.
    assert(callers(full,0xffffffffu,1,[&](unsigned i){
        const unsigned mask=__ballot_sync(0xffffffffu,i<19);
        values[i]=i<19?__shfl_sync(mask,static_cast<float>(i),18):static_cast<float>(i);
        counts[i]=shuffle_count;
    })==0);
    for(unsigned i=0;i<32;++i){assert(values[i]==static_cast<float>(i<19?18:i));assert(counts[i]==(i<19?1u:0u));}

    assert(callers({0},1,1,[](unsigned){__shfl_sync(1,1.0f,1);})==1); // absent source
    assert(callers({1},1,1,[](unsigned){__shfl_sync(1,1.0f,0);})==1); // caller not named
    assert(callers({0},1,0,[](unsigned){__shfl_sync(1,1.0f,0);})==1); // budget exceeded
    assert(callers({0},1,1,[](unsigned){__shfl_sync(1,1.0f,0,16);})==1); // unsupported width
    assert(callers({0},3,1,[](unsigned){__shfl_sync(3,1.0f,0);})==1); // missing named caller
    assert(callers({0,1},3,1,[](unsigned i){__shfl_sync(i?3u:1u,1.0f,0);})>=1); // mismatched instances
    std::cout<<"full32 ballot, high bit, variable subset, values/counts and six negative contracts pass\n";
}
