// Original concise task paraphrases; official LeetCode pages are provenance.
const problem = (id, slug, difficulty, task, signature, examples) => ({ id, slug, difficulty, title: slug.split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join(' '), url:`https://leetcode.com/problems/${slug}/`, task, signature, examples });
export const problems = [
 problem(4,'median-of-two-sorted-arrays','Hard','Return the median of two ascending arrays; their combined length is positive. Target O(log(m+n)).','solve(nums1, nums2)',[[[[1,3],[2]],2],[[[1,2],[3,4]],2.5]]),
 problem(10,'regular-expression-matching','Hard','Match the entire string against a pattern containing lowercase letters, dot (one arbitrary character), and star (zero or more of the preceding atom). Patterns are valid.','solve(s, p)',[[['aa','a*'],true],[['ab','.*'],true],[['mississippi','mis*is*p*.'],false]]),
 problem(32,'longest-valid-parentheses','Hard','Return the length of the longest contiguous well-formed parentheses substring.','solve(s)',[[[')()())'],4],[['(()'],2]]),
 problem(42,'trapping-rain-water','Hard','Given nonnegative bar heights of unit width, return total trapped water.','solve(height)',[[[[0,1,0,2,1,0,1,3,2,1,2,1]],6]]),
 problem(44,'wildcard-matching','Hard','Match the entire string: question mark matches one character; star matches any sequence including empty.','solve(s, p)',[[['adceb','*a*b'],true],[['acdcb','a*c?b'],false]]),
 problem(76,'minimum-window-substring','Hard','Return the shortest substring of s containing every character of t with multiplicity. Return empty if impossible. Test inputs with competing equal minima accept any valid shortest window.','solve(s, t)',[[['ADOBECODEBANC','ABC'],'BANC']]),
 problem(84,'largest-rectangle-in-histogram','Hard','Return the largest rectangle area under nonnegative unit-width histogram bars.','solve(heights)',[[[[2,1,5,6,2,3]],10]]),
 problem(85,'maximal-rectangle','Hard','Given a rectangular matrix of string zeros and ones, return the largest all-one rectangle area.','solve(matrix)',[[[[['1','0','1','0','0'],['1','0','1','1','1'],['1','1','1','1','1'],['1','0','0','1','0']]],6]]),
 problem(115,'distinct-subsequences','Hard','Count ways to select increasing positions of s spelling t. Results in tests fit a signed 32-bit integer.','solve(s, t)',[[['rabbbit','rabbit'],3],[['babgbag','bag'],5]]),
 problem(132,'palindrome-partitioning-ii','Hard','Return the minimum cuts partitioning a nonempty string into palindrome substrings.','solve(s)',[[['aab'],1],[['a'],0]]),
 problem(239,'sliding-window-maximum','Hard','Return the maximum of each contiguous length-k window, with 1 <= k <= nums.length. Target O(n).','solve(nums, k)',[[[[1,3,-1,-3,5,3,6,7],3],[3,3,5,5,6,7]]]),
 problem(312,'burst-balloons','Hard','Burst all balloons to maximize coins. Bursting value v earns left*v*right using surviving neighbors, with outside neighbors equal to 1.','solve(nums)',[[[[3,1,5,8]],167]]),
 problem(315,'count-of-smaller-numbers-after-self','Hard','For each index return the count of strictly smaller numbers to its right. Target O(n log n).','solve(nums)',[[[[5,2,6,1]],[2,1,1,0]]]),
 problem(329,'longest-increasing-path-in-a-matrix','Hard','Return the longest strictly increasing path length in an integer matrix using orthogonal moves.','solve(matrix)',[[[[[9,9,4],[6,6,8],[2,1,1]]],4]]),
 problem(493,'reverse-pairs','Hard','Count index pairs i<j where nums[i] > 2*nums[j]. Target O(n log n).','solve(nums)',[[[[1,3,2,3,1]],2],[[[2,4,3,5,1]],3]]),
 problem(3,'longest-substring-without-repeating-characters','Medium','Return the length of the longest contiguous substring with no repeated characters.','solve(s)',[[['abcabcbb'],3],[['bbbbb'],1]]),
 problem(33,'search-in-rotated-sorted-array','Medium','Search a rotated strictly increasing array for target; return its index or -1. Target O(log n).','solve(nums, target)',[[[[4,5,6,7,0,1,2],0],4]]),
 problem(56,'merge-intervals','Medium','Merge overlapping closed intervals; return disjoint intervals sorted by start. Touching endpoints overlap.','solve(intervals)',[[[[[1,3],[2,6],[8,10],[15,18]]],[[1,6],[8,10],[15,18]]]]),
 problem(200,'number-of-islands','Medium','Count orthogonally connected groups of string ones in a rectangular grid of string zeros and ones.','solve(grid)',[[[[['1','1','0'],['0','1','0'],['1','0','1']]],3]]),
 problem(322,'coin-change','Medium','Return the fewest coins totaling amount with unlimited positive denominations, or -1 if impossible.','solve(coins, amount)',[[[[1,2,5],11],3],[[[2],3],-1]]),
 problem(1,'two-sum','Easy','Return any two distinct indices whose values sum to target. Exactly one unordered index pair exists.','solve(nums, target)',[[[[2,7,11,15],9],[0,1]]]),
 problem(20,'valid-parentheses','Easy','Determine whether brackets (), [], {} are properly balanced and nested.','solve(s)',[[['()[]{}'],true],[['([)]'],false]]),
 problem(121,'best-time-to-buy-and-sell-stock','Easy','Return maximum profit from one buy followed by one later sell; return zero when no positive profit exists.','solve(prices)',[[[[7,1,5,3,6,4]],5]]),
 problem(217,'contains-duplicate','Easy','Return whether any integer occurs more than once in the array.','solve(nums)',[[[[1,2,3,1]],true]]),
 problem(704,'binary-search','Easy','Search an ascending array of distinct integers for target; return its index or -1. Target O(log n).','solve(nums, target)',[[[[-1,0,3,5,9,12],9],4]])
];
